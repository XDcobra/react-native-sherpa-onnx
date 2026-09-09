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
 * hit (non-empty result.keyword) and always resets the stream after a hit.
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

        while (spotter.isReady(stream)) {
          spotter.decode(stream)
        }
        chunksProcessed++

        maybeCommitHit(spotter.getResult(stream))
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
      Log.i(
        LOG_TAG,
        "$PREFIX worker end pipelineId=$pipelineId hits=$hitCount " +
          "chunks=$chunksProcessed unitsRead=$unitsRead unitsWritten=$unitsWritten",
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
    val tokens = result.tokens ?: emptyArray()
    val timestamps = result.timestamps ?: floatArrayOf()
    val segmentMeta = mapOf<String, Any>(
      "__segmentReason" to "endpoint",
      "__segmentSource" to SOURCE,
      "__segmentCreatedAtMs" to createdAtMs,
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
      "$PREFIX hit pipelineId=$pipelineId keyword=$keyword segmentIndex=$segmentIndex",
    )
    spotter.reset(stream)
  }

  private fun autoFlushAndCommit(endOfAudio: Boolean) {
    if (endOfAudio) {
      stream.inputFinished()
    }
    while (spotter.isReady(stream)) {
      spotter.decode(stream)
    }
    maybeCommitHit(spotter.getResult(stream))
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
    if (!isRunning) return
    isRunning = false
    lock.withLock { dataAvailable.signal() }
    executor.shutdown()
    if (!executor.awaitTermination(5, TimeUnit.SECONDS)) {
      executor.shutdownNow()
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
