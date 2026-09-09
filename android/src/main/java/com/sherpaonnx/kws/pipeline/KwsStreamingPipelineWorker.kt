package com.sherpaonnx.kws.pipeline

import android.util.Log
import com.k2fsa.sherpa.onnx.KeywordSpotter
import com.k2fsa.sherpa.onnx.OnlineStream
import com.sherpaonnx.audio.pipeline.LiveEntry
import com.sherpaonnx.audio.pipeline.LiveFramesAppendedEvent
import com.sherpaonnx.audio.pipeline.StreamingPipelineStatus
import com.sherpaonnx.audio.pipeline.StreamingPipelineWorker
import com.sherpaonnx.text.pipeline.LiveTextEntry
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Native streaming worker for Keyword Spotting.
 *
 * Mirrors [com.sherpaonnx.stt.pipeline.SttPipelineWorker] but commits on keyword
 * hit. Upstream contract: after each decode, getResult → on hit commit +
 * reset(stream) before further decode (getResult is one-shot per hit).
 */
class KwsStreamingPipelineWorker(
  override val pipelineId: String,
  private val spotter: KeywordSpotter,
  private val stream: OnlineStream,
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

        stream.acceptWaveform(chunk, sampleRate)
        unitsRead += chunk.size

        var decodeSteps = 0
        var commitsThisChunk = 0
        while (spotter.isReady(stream)) {
          spotter.decode(stream)
          decodeSteps++
          decodeStepsTotal++
          // One getResult per decode — do not call getResult again before reset.
          val result = spotter.getResult(stream)
          val kw = result.keyword?.trim().orEmpty()
          if (kw.isNotEmpty()) {
            Log.i(
              LOG_TAG,
              "$PREFIX decodeHit pipelineId=$pipelineId chunk=$chunksProcessed " +
                "decodeStep=$decodeSteps keyword=$kw " +
                "tokens=${result.tokens?.size ?: 0} " +
                "ts0=${result.timestamps?.firstOrNull()}",
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
      inputEntry.releaseCursor(audioCursorId)
      appendListener?.let { inputEntry.removeAppendListener(it) }
      appendListener = null
      try {
        stream.release()
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
  }

  private fun maybeCommitHit(result: com.k2fsa.sherpa.onnx.KeywordSpotterResult) {
    val keyword = result.keyword?.trim().orEmpty()
    if (keyword.isEmpty()) {
      return
    }

    hitCount++
    val createdAtMs = System.currentTimeMillis()
    // Copy tokens/timestamps before reset — emit is posted async to the main looper.
    val tokens = (result.tokens ?: emptyArray()).map { it.orEmpty() }.toTypedArray()
    val timestamps = (result.timestamps ?: floatArrayOf()).copyOf()
    val segmentMeta = mapOf<String, Any>(
      "__segmentReason" to "endpoint",
      "__segmentSource" to SOURCE,
      "__segmentCreatedAtMs" to createdAtMs.toDouble(),
      // Public meta (survives JS toPublicTextMeta) so onKeyword can filter kws_stream.
      "source" to SOURCE,
      "keyword" to keyword,
    )
    // RN notify comes from LiveTextEntry commit listeners registered at
    // createLiveTextBuffer (single emit, main-looper posted) — do not emit here.
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
        "→ reset(stream)",
    )
    spotter.reset(stream)
  }

  private fun appendTailPaddingIfNeeded(endOfAudio: Boolean) {
    if (!endOfAudio) {
      return
    }
    val padSamples = (sampleRate * TAIL_PADDING_SECONDS).toInt().coerceAtLeast(1)
    val tail = FloatArray(padSamples)
    stream.acceptWaveform(tail, sampleRate)
    unitsRead += padSamples
    Log.i(
      LOG_TAG,
      "$PREFIX tailPad pipelineId=$pipelineId samples=$padSamples sr=$sampleRate",
    )
  }

  private fun autoFlushAndCommit(endOfAudio: Boolean) {
    appendTailPaddingIfNeeded(endOfAudio)
    if (endOfAudio) {
      stream.inputFinished()
    }
    var decodeSteps = 0
    var commits = 0
    while (spotter.isReady(stream)) {
      spotter.decode(stream)
      decodeSteps++
      decodeStepsTotal++
      val result = spotter.getResult(stream)
      val kw = result.keyword?.trim().orEmpty()
      if (kw.isNotEmpty()) {
        Log.i(
          LOG_TAG,
          "$PREFIX flushHit pipelineId=$pipelineId endOfAudio=$endOfAudio " +
            "decodeStep=$decodeSteps keyword=$kw",
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
            spotter.reset(stream)
            cmd.completion.complete(Unit)
          } catch (e: Exception) {
            cmd.completion.completeExceptionally(e)
          }
        }
      }
    }
  }

  override fun stop() {
    // Always awaitTermination: isRunning=false in finally can race stream.release
    // with spotter.release() during unload if stop() returns early.
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
