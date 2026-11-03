package com.sherpaonnx.stt.pipeline

import android.util.Log
import com.sherpaonnx.audio.pipeline.LiveEntry
import com.sherpaonnx.audio.pipeline.LiveFramesAppendedEvent
import com.sherpaonnx.audio.pipeline.StreamingPipelineStatus
import com.sherpaonnx.audio.pipeline.StreamingPipelineWorker
import com.sherpaonnx.stt.facade.SherpaOnnxOnlineSttHelper
import com.sherpaonnx.text.pipeline.LiveTextEntry
import com.sherpaonnx.text.pipeline.TextSegment
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

class SttPipelineWorker(
  override val pipelineId: String,
  private val instanceId: String,
  private val streamId: String,
  private val sampleRate: Int,
  private val inputEntry: LiveEntry,
  private val outputEntry: LiveTextEntry,
  private val chunkSize: Int = 6400,
  private val onSegmentCommitted: ((segment: TextSegment, totalSegments: Int) -> Unit)? = null,
) : StreamingPipelineWorker {

  companion object {
    private const val LOG_TAG = "SherpaOnnx:SttPipelineWorker"
  }

  /** First non-blank streaming hypothesis (for sessionEnd summary). */
  private var dbgFirstHypothesis: String? = null

  /** Commits from mid-stream endpoint detection (before EOF). */
  private var dbgEndpointCommits: Int = 0

  @Volatile
  override var isRunning: Boolean = false
    private set

  private val executor = Executors.newSingleThreadExecutor { r ->
    Thread(r, "stt-pipeline-$pipelineId").apply { isDaemon = true }
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

  private val lock = ReentrantLock()
  private val dataAvailable = lock.newCondition()
  private var appendListener: ((LiveFramesAppendedEvent) -> Unit)? = null

  private val commandQueue = LinkedBlockingQueue<PipelineCommand>()
  private val cmdLock = Any()

  private sealed class PipelineCommand {
    class Flush(val completion: CompletableFuture<Unit>) : PipelineCommand()
    class Reset(val completion: CompletableFuture<Unit>) : PipelineCommand()
  }

  private data class StreamResult(
    val text: String,
    val tokens: Array<String>,
    val timestamps: FloatArray,
  )

  private fun readResult(): StreamResult {
    @Suppress("UNCHECKED_CAST")
    val raw = SherpaOnnxOnlineSttHelper.nativeGetResult(instanceId, streamId)
    val text = raw?.get("text") as? String ?: ""
    val tokensList = raw?.get("tokens") as? ArrayList<*>
    val tokens = tokensList
      ?.mapNotNull { it as? String }
      ?.toTypedArray()
      ?: emptyArray()
    val timestamps = when (val ts = raw?.get("timestamps")) {
      is FloatArray -> ts
      is ArrayList<*> -> {
        val out = FloatArray(ts.size)
        for (i in ts.indices) {
          out[i] = (ts[i] as? Number)?.toFloat() ?: 0f
        }
        out
      }
      else -> FloatArray(0)
    }
    return StreamResult(text = text, tokens = tokens, timestamps = timestamps)
  }

  override fun start() {
    isRunning = true
    audioCursorId = inputEntry.createCursorHandle()

    appendListener = { _ ->
      lock.withLock { dataAvailable.signal() }
    }
    inputEntry.addAppendListener(appendListener!!)

    executor.submit { runLoop() }
  }

  private fun previewForLog(s: String, maxChars: Int = 96): String {
    val t = s.trim()
    if (t.length <= maxChars) return t
    return t.take(maxChars) + "…"
  }

  private fun runLoop() {
    try {
      while (isRunning) {
        processCommands()

        val chunk = inputEntry.drainCursor(audioCursorId, chunkSize)
        if (chunk.isEmpty()) {
          if (inputEntry.state == LiveEntry.State.FINISHED) {
            autoFlushAndCommit(endOfAudio = true)
            break
          }
          lock.withLock {
            dataAvailable.await(10, TimeUnit.MILLISECONDS)
          }
          continue
        }

        SherpaOnnxOnlineSttHelper.nativeAcceptWaveform(
          instanceId, streamId, sampleRate, chunk
        )
        unitsRead += chunk.size

        while (SherpaOnnxOnlineSttHelper.nativeIsReady(instanceId, streamId)) {
          SherpaOnnxOnlineSttHelper.nativeDecode(instanceId, streamId)
        }
        chunksProcessed++

        val result = readResult()

        if (result.text.isNotBlank()) {
          if (dbgFirstHypothesis == null) dbgFirstHypothesis = result.text
        }

        if (result.text.isNotBlank()) {
          outputEntry.writePartial(result.text)
        }

        if (SherpaOnnxOnlineSttHelper.nativeIsEndpoint(instanceId, streamId)) {
          if (result.text.isNotBlank()) {
            dbgEndpointCommits++
            val createdAtMs = System.currentTimeMillis()
            val segmentMeta = mapOf<String, Any>(
              "__segmentReason" to "endpoint",
              "__segmentSource" to "segmentation_engine",
              "__segmentCreatedAtMs" to createdAtMs,
            )
            val segmentIndex = outputEntry.commitSegment(
              text = result.text,
              tokens = result.tokens,
              timestamps = result.timestamps,
              source = "stt_stream",
              meta = segmentMeta,
            )
            onSegmentCommitted?.invoke(
              TextSegment(
                text = result.text,
                tokens = result.tokens,
                timestamps = result.timestamps,
                source = "stt_stream",
                segmentIndex = segmentIndex,
                meta = segmentMeta,
              ),
              outputEntry.segmentCount,
            )
            unitsWritten += result.text.length
            outputEntry.writePartial("")
          }
          SherpaOnnxOnlineSttHelper.nativeResetStream(instanceId, streamId)
        }
      }
    } catch (e: Exception) {
      error = e.message ?: "Unknown error in STT pipeline"
    } finally {
      inputEntry.releaseCursor(audioCursorId)
      appendListener?.let { inputEntry.removeAppendListener(it) }
      appendListener = null
      SherpaOnnxOnlineSttHelper.nativeReleaseStream(instanceId, streamId)
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
      executor.shutdown()
    }
  }

  /**
   * Decode tail and optionally commit the final hypothesis.
   *
   * When [endOfAudio] is true (live input buffer finalized / file ingest done),
   * call InputFinished so sherpa-onnx can flush internal frames before the last
   * decode passes — omitting this often truncates the transcript.
   */
  private fun autoFlushAndCommit(endOfAudio: Boolean = false) {
    if (endOfAudio) {
      SherpaOnnxOnlineSttHelper.nativeInputFinished(instanceId, streamId)
    }
    var tailDecodePasses = 0
    while (SherpaOnnxOnlineSttHelper.nativeIsReady(instanceId, streamId)) {
      SherpaOnnxOnlineSttHelper.nativeDecode(instanceId, streamId)
      tailDecodePasses++
    }
    val result = readResult()
    if (endOfAudio) {
      val firstLen = dbgFirstHypothesis?.length ?: 0
      val finalLen = result.text.length
      val ft = dbgFirstHypothesis?.trimStart().orEmpty()
      val rt = result.text.trimStart()
      val finalExtendsFirstOpening =
        ft.isNotEmpty() && rt.startsWith(ft) && rt.length >= ft.length
      Log.i(
        LOG_TAG,
        "sessionEnd {pipelineId=$pipelineId, unitsRead=$unitsRead, chunks=$chunksProcessed, " +
          "endpointCommits=$dbgEndpointCommits, tailDecodePasses=$tailDecodePasses, " +
          "firstHypLen=$firstLen, finalLen=$finalLen, finalExtendsFirst=$finalExtendsFirstOpening, " +
          "preview=\"${previewForLog(result.text, 80)}\"}",
      )
    }
    if (result.text.isNotBlank()) {
      val createdAtMs = System.currentTimeMillis()
      val segmentMeta = mapOf<String, Any>(
        "__segmentReason" to "endpoint",
        "__segmentSource" to "segmentation_engine",
        "__segmentCreatedAtMs" to createdAtMs,
      )
      val segmentIndex = outputEntry.commitSegment(
        text = result.text,
        tokens = result.tokens,
        timestamps = result.timestamps,
        source = "stt_stream",
        meta = segmentMeta,
      )
      onSegmentCommitted?.invoke(
        TextSegment(
          text = result.text,
          tokens = result.tokens,
          timestamps = result.timestamps,
          source = "stt_stream",
          segmentIndex = segmentIndex,
          meta = segmentMeta,
        ),
        outputEntry.segmentCount,
      )
      unitsWritten += result.text.length
      outputEntry.writePartial("")
    }
  }

  private fun processCommands() {
    while (true) {
      val cmd = commandQueue.poll() ?: return
      when (cmd) {
        is PipelineCommand.Flush -> {
          try {
            // Do not call InputFinished: more audio may still arrive.
            autoFlushAndCommit(endOfAudio = false)
            cmd.completion.complete(Unit)
          } catch (e: Exception) {
            cmd.completion.completeExceptionally(e)
          }
        }
        is PipelineCommand.Reset -> {
          try {
            SherpaOnnxOnlineSttHelper.nativeResetStream(instanceId, streamId)
            outputEntry.writePartial("")
            cmd.completion.complete(Unit)
          } catch (e: Exception) {
            cmd.completion.completeExceptionally(e)
          }
        }
      }
    }
  }

  override fun stop() {
    // Always join. Early `!isRunning` return raced unload/release against the
    // worker finally block (isRunning cleared before stream.release completes).
    isRunning = false
    lock.withLock { dataAvailable.signal() }
    if (!executor.isShutdown) {
      executor.shutdown()
    }
    if (!executor.isTerminated) {
      if (!executor.awaitTermination(5, TimeUnit.SECONDS)) {
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
