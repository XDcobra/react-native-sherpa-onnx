package com.sherpaonnx.kws.pipeline

import android.util.Log
import com.sherpaonnx.audio.pipeline.LiveEntry
import com.sherpaonnx.audio.pipeline.LiveFramesAppendedEvent
import com.sherpaonnx.audio.pipeline.StreamingPipelineStatus
import com.sherpaonnx.audio.pipeline.StreamingPipelineWorker
import com.sherpaonnx.kws.facade.SherpaOnnxKwsHelper
import com.sherpaonnx.lifecycle.NativeInstanceGate
import com.sherpaonnx.text.pipeline.LiveTextEntry
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Native streaming worker for Keyword Spotting (shared C API via JNI).
 *
 * After each decode, getResult → on hit commit + reset(stream) before further
 * decode (getResult is one-shot per hit).
 */
class KwsStreamingPipelineWorker(
  override val pipelineId: String,
  private val instanceId: String,
  private val streamId: String,
  private val inputEntry: LiveEntry,
  private val outputEntry: LiveTextEntry,
  private val sampleRate: Int,
  /** Samples per drain; default 1600 ≈ 100ms @ 16 kHz for lower wake latency. */
  private val chunkSize: Int = DEFAULT_CHUNK_SIZE,
) : StreamingPipelineWorker {

  companion object {
    private const val LOG_TAG = "SherpaOnnxKws"
    private const val PREFIX = "[SherpaOnnx:kws]"
    private const val SOURCE = "kws_stream"
    /** Match sherpa-onnx python KWS examples: trailing silence before inputFinished. */
    private const val TAIL_PADDING_SECONDS = 0.66f
    const val DEFAULT_CHUNK_SIZE = 1600
  }

  private val gateKey = "kws:$instanceId"

  @Volatile
  override var isRunning: Boolean = false
    private set

  private val executor = Executors.newSingleThreadExecutor { r ->
    Thread(r, "kws-pipeline-$pipelineId").apply { isDaemon = true }
  }

  @Volatile
  private var chunksProcessed = 0L
  @Volatile
  private var unitsRead = 0L
  @Volatile
  private var unitsWritten = 0L
  @Volatile
  private var error: String? = null
  private var audioCursorId: Int = -1
  private var hitCount = 0
  private var decodeStepsTotal = 0L
  private var emptyGetResults = 0L

  private val lock = ReentrantLock()
  private val dataAvailable = lock.newCondition()
  private var appendListener: ((LiveFramesAppendedEvent) -> Unit)? = null

  private val commandQueue = LinkedBlockingQueue<PipelineCommand>()
  private val cmdLock = Any()

  private sealed class PipelineCommand {
    class Flush(val completion: CompletableFuture<Unit>) : PipelineCommand()
    class Reset(val completion: CompletableFuture<Unit>) : PipelineCommand()
  }

  override fun start() {
    isRunning = true
    audioCursorId = inputEntry.createCursorHandle()

    appendListener = { _ ->
      lock.withLock { dataAvailable.signal() }
    }
    inputEntry.addAppendListener(appendListener!!)

    Log.i(LOG_TAG, "$PREFIX worker start pipelineId=$pipelineId chunkSize=$chunkSize")
    executor.submit { runLoop() }
  }

  private fun runLoop() {
    if (!NativeInstanceGate.beginUse(gateKey)) {
      error = "KWS instance unavailable"
      Log.e(LOG_TAG, "$PREFIX beginUse failed pipelineId=$pipelineId")
      finishCleanup()
      return
    }
    try {
      while (isRunning) {
        processCommands()

        val chunk = inputEntry.drainCursor(audioCursorId, chunkSize)
        if (chunk.isEmpty()) {
          if (inputEntry.state == LiveEntry.State.FINISHED) {
            Log.i(
              LOG_TAG,
              "$PREFIX eof pipelineId=$pipelineId hitsSoFar=$hitCount " +
                "chunks=$chunksProcessed unitsRead=$unitsRead → autoFlush",
            )
            autoFlushAndCommit(endOfAudio = true)
            break
          }
          lock.withLock {
            dataAvailable.await(10, TimeUnit.MILLISECONDS)
          }
          continue
        }

        SherpaOnnxKwsHelper.nativeAcceptWaveform(instanceId, streamId, sampleRate, chunk)
        unitsRead += chunk.size

        var decodeSteps = 0
        var commitsThisChunk = 0
        while (SherpaOnnxKwsHelper.nativeIsReady(instanceId, streamId)) {
          SherpaOnnxKwsHelper.nativeDecode(instanceId, streamId)
          decodeSteps++
          decodeStepsTotal++
          val result = readResult()
          val kw = result.keyword
          if (kw.isNotEmpty()) {
            Log.i(
              LOG_TAG,
              "$PREFIX decodeHit pipelineId=$pipelineId chunk=$chunksProcessed " +
                "decodeStep=$decodeSteps keyword=$kw " +
                "tokens=${result.tokens.size} " +
                "ts0=${result.timestamps.firstOrNull()} startTime=${result.startTime}",
            )
            val before = hitCount
            maybeCommitHit(result)
            if (hitCount > before) {
              commitsThisChunk++
            }
          } else {
            emptyGetResults++
          }
        }
        chunksProcessed++

        if (commitsThisChunk > 0) {
          Log.d(
            LOG_TAG,
            "$PREFIX chunkDone pipelineId=$pipelineId chunk=$chunksProcessed " +
              "samples=${chunk.size} decodeSteps=$decodeSteps " +
              "commitsThisChunk=$commitsThisChunk hitsTotal=$hitCount",
          )
        }
      }
    } catch (e: Exception) {
      error = e.message ?: "Unknown error in KWS pipeline"
      Log.e(LOG_TAG, "$PREFIX worker error pipelineId=$pipelineId: $error", e)
    } finally {
      NativeInstanceGate.endUse(gateKey)
      finishCleanup()
    }
  }

  private data class HitResult(
    val keyword: String,
    val tokens: Array<String>,
    val timestamps: FloatArray,
    val startTime: Float,
  )

  private fun readResult(): HitResult {
    val raw = SherpaOnnxKwsHelper.nativeGetResult(instanceId, streamId)
    val keyword = (raw?.get("keyword") as? String)?.trim().orEmpty()
    @Suppress("UNCHECKED_CAST")
    val tokenList = raw?.get("tokens") as? ArrayList<*>
    val tokens = tokenList
      ?.map { it?.toString().orEmpty() }
      ?.toTypedArray()
      ?: emptyArray()
    val tsArr = raw?.get("timestamps") as? FloatArray ?: floatArrayOf()
    val startTime = (raw?.get("startTime") as? Number)?.toFloat() ?: 0f
    return HitResult(keyword, tokens, tsArr.copyOf(), startTime)
  }

  private fun maybeCommitHit(result: HitResult) {
    val keyword = result.keyword
    if (keyword.isEmpty()) {
      return
    }

    hitCount++
    val createdAtMs = System.currentTimeMillis()
    val tokens = result.tokens
    val timestamps = result.timestamps
    val segmentMeta = mapOf<String, Any>(
      "__segmentReason" to "endpoint",
      "__segmentSource" to SOURCE,
      "__segmentCreatedAtMs" to createdAtMs.toDouble(),
      "source" to SOURCE,
      "keyword" to keyword,
      "startTime" to result.startTime.toDouble(),
    )
    val segmentIndex = outputEntry.commitSegment(
      text = keyword,
      tokens = tokens,
      timestamps = timestamps,
      source = SOURCE,
      meta = segmentMeta,
    )
    unitsWritten += keyword.length
    Log.i(
      LOG_TAG,
      "$PREFIX hit pipelineId=$pipelineId keyword=$keyword segmentIndex=$segmentIndex " +
        "hitCount=$hitCount tokens=${tokens.size} ts0=${timestamps.firstOrNull()} " +
        "startTime=${result.startTime} → reset(stream)",
    )
    SherpaOnnxKwsHelper.nativeResetStream(instanceId, streamId)
  }

  private fun appendTailPaddingIfNeeded(endOfAudio: Boolean) {
    if (!endOfAudio) {
      return
    }
    val padSamples = (sampleRate * TAIL_PADDING_SECONDS).toInt().coerceAtLeast(1)
    val tail = FloatArray(padSamples)
    SherpaOnnxKwsHelper.nativeAcceptWaveform(instanceId, streamId, sampleRate, tail)
    unitsRead += padSamples
    Log.i(
      LOG_TAG,
      "$PREFIX tailPad pipelineId=$pipelineId samples=$padSamples sr=$sampleRate",
    )
  }

  private fun autoFlushAndCommit(endOfAudio: Boolean) {
    appendTailPaddingIfNeeded(endOfAudio)
    if (endOfAudio) {
      SherpaOnnxKwsHelper.nativeInputFinished(instanceId, streamId)
    }
    var decodeSteps = 0
    var commits = 0
    while (SherpaOnnxKwsHelper.nativeIsReady(instanceId, streamId)) {
      SherpaOnnxKwsHelper.nativeDecode(instanceId, streamId)
      decodeSteps++
      decodeStepsTotal++
      val result = readResult()
      if (result.keyword.isNotEmpty()) {
        Log.i(
          LOG_TAG,
          "$PREFIX flushHit pipelineId=$pipelineId endOfAudio=$endOfAudio " +
            "decodeStep=$decodeSteps keyword=${result.keyword}",
        )
        val before = hitCount
        maybeCommitHit(result)
        if (hitCount > before) {
          commits++
        }
      } else {
        emptyGetResults++
      }
    }
    Log.i(
      LOG_TAG,
      "$PREFIX flushDone pipelineId=$pipelineId endOfAudio=$endOfAudio " +
        "decodeSteps=$decodeSteps commits=$commits hitsTotal=$hitCount",
    )
  }

  private fun processCommands() {
    while (true) {
      val cmd = commandQueue.poll() ?: return
      when (cmd) {
        is PipelineCommand.Flush -> {
          try {
            autoFlushAndCommit(endOfAudio = false)
            cmd.completion.complete(Unit)
          } catch (e: Exception) {
            cmd.completion.completeExceptionally(e)
          }
        }
        is PipelineCommand.Reset -> {
          try {
            SherpaOnnxKwsHelper.nativeResetStream(instanceId, streamId)
            cmd.completion.complete(Unit)
          } catch (e: Exception) {
            cmd.completion.completeExceptionally(e)
          }
        }
      }
    }
  }

  private fun finishCleanup() {
    inputEntry.releaseCursor(audioCursorId)
    appendListener?.let { inputEntry.removeAppendListener(it) }
    appendListener = null
    try {
      SherpaOnnxKwsHelper.nativeReleaseStream(instanceId, streamId)
    } catch (e: Exception) {
      Log.w(LOG_TAG, "$PREFIX stream release failed pipelineId=$pipelineId: ${e.message}")
    }
    synchronized(cmdLock) {
      while (true) {
        val cmd = commandQueue.poll() ?: break
        when (cmd) {
          is PipelineCommand.Flush -> cmd.completion.complete(Unit)
          is PipelineCommand.Reset -> cmd.completion.complete(Unit)
        }
      }
      isRunning = false
    }
    val audioSec =
      if (sampleRate > 0) unitsRead.toDouble() / sampleRate.toDouble() else 0.0
    Log.i(
      LOG_TAG,
      "$PREFIX sessionSummary pipelineId=$pipelineId hits=$hitCount " +
        "chunks=$chunksProcessed unitsRead=$unitsRead audioSec=${"%.2f".format(audioSec)} " +
        "decodeSteps=$decodeStepsTotal emptyGetResults=$emptyGetResults " +
        "unitsWritten=$unitsWritten " +
        "verdict=${
          when {
            unitsRead <= 0L -> "no_audio"
            decodeStepsTotal <= 0L -> "no_decode"
            hitCount <= 0 -> "model_no_match"
            else -> "ok_hits"
          }
        }",
    )
    executor.shutdown()
  }

  override fun stop() {
    // Always awaitTermination: isRunning=false in finally can race stream.release
    // with spotter unload during unload if stop() returns early.
    isRunning = false
    lock.withLock { dataAvailable.signal() }
    if (!executor.isShutdown) {
      executor.shutdown()
    }
    if (!executor.isTerminated) {
      if (!executor.awaitTermination(5, TimeUnit.SECONDS)) {
        Log.w(LOG_TAG, "$PREFIX stop await timeout pipelineId=$pipelineId → shutdownNow")
        executor.shutdownNow()
        executor.awaitTermination(2, TimeUnit.SECONDS)
      }
    }
  }

  override fun flush(): CompletableFuture<Unit> {
    val future = CompletableFuture<Unit>()
    synchronized(cmdLock) {
      if (!isRunning) {
        future.complete(Unit)
        return future
      }
      commandQueue.put(PipelineCommand.Flush(future))
    }
    lock.withLock { dataAvailable.signal() }
    return future
  }

  override fun reset(): CompletableFuture<Unit> {
    val future = CompletableFuture<Unit>()
    synchronized(cmdLock) {
      if (!isRunning) {
        future.complete(Unit)
        return future
      }
      commandQueue.put(PipelineCommand.Reset(future))
    }
    lock.withLock { dataAvailable.signal() }
    return future
  }

  override fun getStatus() = StreamingPipelineStatus(
    isRunning = isRunning,
    chunksProcessed = chunksProcessed,
    unitsRead = unitsRead,
    unitsWritten = unitsWritten,
    error = error,
  )

  override fun release() {
    stop()
  }
}
