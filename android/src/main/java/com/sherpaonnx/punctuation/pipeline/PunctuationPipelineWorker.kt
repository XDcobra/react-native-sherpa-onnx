package com.sherpaonnx.punctuation.pipeline

import com.k2fsa.sherpa.onnx.OnlinePunctuation
import com.sherpaonnx.audio.pipeline.StreamingPipelineStatus
import com.sherpaonnx.audio.pipeline.StreamingPipelineWorker
import com.sherpaonnx.punctuation.core.PunctuationTextInputNormalization
import com.sherpaonnx.text.pipeline.LiveTextEntry
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

internal class PunctuationPipelineWorker(
  override val pipelineId: String,
  private val engine: OnlinePunctuation,
  private val inputEntry: LiveTextEntry,
  private val outputEntry: LiveTextEntry,
  private val textInputNormalization: String = PunctuationTextInputNormalization.DEFAULT_MODE,
) : StreamingPipelineWorker {
  @Volatile
  override var isRunning: Boolean = false
    private set

  private val executor = Executors.newSingleThreadExecutor { r ->
    Thread(r, "punctuation-pipeline-$pipelineId").apply { isDaemon = true }
  }

  @Volatile private var chunksProcessed = 0L
  @Volatile private var unitsRead = 0L
  @Volatile private var unitsWritten = 0L
  @Volatile private var error: String? = null

  private var textCursorId: Int = -1
  private var appendListenerToken: Int = -1

  private val lock = ReentrantLock()
  private val dataAvailable = lock.newCondition()
  private val commandQueue = LinkedBlockingQueue<PipelineCommand>()

  /**
   * Once the live input is [LiveTextEntry.State.FINISHED], the worker must not
   * shut down until at least one [PipelineCommand.Flush] has completed while
   * the input is still finished. That way `StreamingPipelineWorker.flush()` remains usable as a
   * synchronization barrier (avoids races where the JS layer finalizes the
   * input and then calls flush after a brief segment-drain window).
   * Single-threaded: only the executor thread touches this flag.
   */
  private var postFinishFlushCompleted = false

  private sealed class PipelineCommand {
    class Flush(val completion: CompletableFuture<Unit>) : PipelineCommand()
    class Reset(val completion: CompletableFuture<Unit>) : PipelineCommand()
  }

  override fun start() {
    isRunning = true
    textCursorId = inputEntry.createSegmentCursor()
    appendListenerToken = inputEntry.addAppendListener {
      lock.withLock { dataAvailable.signal() }
    }
    executor.submit { runLoop() }
  }

  private fun runLoop() {
    try {
      while (isRunning) {
        processCommands()
        val segments = inputEntry.drainSegments(textCursorId, 1)
        if (segments.isEmpty()) {
          if (inputEntry.state == LiveTextEntry.State.FINISHED) {
            if (postFinishFlushCompleted) break
            lock.withLock { dataAvailable.await(50, TimeUnit.MILLISECONDS) }
            continue
          }
          lock.withLock { dataAvailable.await(50, TimeUnit.MILLISECONDS) }
          continue
        }
        val segment = segments[0]
        if (segment.text.isBlank()) continue
        punctuateSegment(segment.text, segment.meta)
        chunksProcessed++
      }
    } catch (e: Exception) {
      error = e.message ?: "Unknown error in punctuation pipeline"
    } finally {
      isRunning = false
      if (textCursorId >= 0) inputEntry.releaseSegmentCursor(textCursorId)
      if (appendListenerToken >= 0) inputEntry.removeAppendListener(appendListenerToken)
      drainRemainingCommands()
      executor.shutdown()
    }
  }

  private fun punctuateSegment(text: String, meta: Map<String, Any?>?) {
    val normalized =
      PunctuationTextInputNormalization.normalize(text, textInputNormalization)
    unitsRead += normalized.length
    val punctuated = engine.addPunctuation(normalized)
    val outMeta = mutableMapOf<String, Any?>(
      "__segmentReason" to "punctuation",
      "__segmentSource" to "segmentation_engine",
      "__segmentCreatedAtMs" to System.currentTimeMillis(),
    )
    meta?.forEach { (key, value) ->
      if (!outMeta.containsKey(key)) outMeta[key] = value
    }
    outputEntry.commitSegment(
      text = punctuated,
      source = "punctuation_stream",
      meta = outMeta,
    )
    unitsWritten += punctuated.length
  }

  private fun processCommands() {
    while (true) {
      val cmd = commandQueue.poll() ?: return
      when (cmd) {
        is PipelineCommand.Flush -> {
          try {
            while (true) {
              val remaining = inputEntry.drainSegments(textCursorId, 1)
              if (remaining.isEmpty()) break
              val seg = remaining[0]
              if (seg.text.isBlank()) continue
              punctuateSegment(seg.text, seg.meta)
              chunksProcessed++
            }
            if (inputEntry.state == LiveTextEntry.State.FINISHED) {
              postFinishFlushCompleted = true
            }
            cmd.completion.complete(Unit)
          } catch (e: Exception) {
            cmd.completion.completeExceptionally(e)
          }
        }
        is PipelineCommand.Reset -> {
          try {
            while (inputEntry.drainSegments(textCursorId, 100).isNotEmpty()) { /* skip */ }
            postFinishFlushCompleted = false
            cmd.completion.complete(Unit)
          } catch (e: Exception) {
            cmd.completion.completeExceptionally(e)
          }
        }
      }
    }
  }

  private fun drainRemainingCommands() {
    while (true) {
      val cmd = commandQueue.poll() ?: return
      when (cmd) {
        is PipelineCommand.Flush -> cmd.completion.completeExceptionally(
          IllegalStateException("Pipeline stopped before flush could complete")
        )
        is PipelineCommand.Reset -> cmd.completion.completeExceptionally(
          IllegalStateException("Pipeline stopped before reset could complete")
        )
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
    if (!isRunning) {
      return CompletableFuture<Unit>().also {
        it.completeExceptionally(IllegalStateException("Pipeline is not running"))
      }
    }
    val future = CompletableFuture<Unit>()
    commandQueue.put(PipelineCommand.Flush(future))
    lock.withLock { dataAvailable.signal() }
    return future
  }

  override fun reset(): CompletableFuture<Unit> {
    if (!isRunning) {
      return CompletableFuture<Unit>().also {
        it.completeExceptionally(IllegalStateException("Pipeline is not running"))
      }
    }
    val future = CompletableFuture<Unit>()
    commandQueue.put(PipelineCommand.Reset(future))
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
