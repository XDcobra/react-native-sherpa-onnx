package com.sherpaonnx.audio.pipeline

import android.os.Handler
import android.os.Looper
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap

private const val PIPELINE_COMPLETION_POLL_MS = 20L

/**
 * Tracks live [StreamingPipelineWorker] instances and notifies completion.
 *
 * Completion callbacks (and registry [remove]) are posted onto the main/UI looper.
 * Callers typically build RN `WritableMap` / HybridData and emit JS events; doing that on
 * ForkJoinPool races DestructorThread and aborts with
 * `JNI DETECTED ERROR … jobject is an invalid local reference` in `DeleteGlobalRef`.
 */
object StreamingPipelineRegistry {
  private val pipelines = ConcurrentHashMap<String, StreamingPipelineWorker>()
  private val completionCallbacks =
    ConcurrentHashMap<String, (StreamingPipelineCompletion) -> Unit>()
  private val stopRequested = ConcurrentHashMap.newKeySet<String>()
  // Lazy: JVM unit tests replace [completionPoster] and must not touch Looper at class init.
  private val mainHandler by lazy { Handler(Looper.getMainLooper()) }

  private val defaultCompletionPoster: (() -> Unit) -> Unit = { block ->
    if (Looper.myLooper() == Looper.getMainLooper()) {
      block()
    } else {
      mainHandler.post(block)
    }
  }

  /**
   * Where completion callbacks + release run. Production uses the main looper.
   * Unit tests may replace this (no Robolectric) to assert marshaling without JNI.
   */
  @Volatile
  internal var completionPoster: (() -> Unit) -> Unit = defaultCompletionPoster

  internal fun resetCompletionPosterForTests() {
    completionPoster = defaultCompletionPoster
  }

  fun registerAndStart(
    worker: StreamingPipelineWorker,
    onCompleted: ((StreamingPipelineCompletion) -> Unit)? = null,
  ): String {
    pipelines[worker.pipelineId] = worker
    if (onCompleted != null) {
      completionCallbacks[worker.pipelineId] = onCompleted
    }
    worker.start()
    watchCompletion(worker)
    return worker.pipelineId
  }

  private fun watchCompletion(worker: StreamingPipelineWorker) {
    CompletableFuture.runAsync {
      while (worker.isRunning) {
        try {
          Thread.sleep(PIPELINE_COMPLETION_POLL_MS)
        } catch (_: InterruptedException) {
          break
        }
      }

      val status = try {
        worker.getStatus()
      } catch (e: Exception) {
        StreamingPipelineStatus(
          isRunning = false,
          chunksProcessed = 0,
          unitsRead = 0,
          unitsWritten = 0,
          error = e.message ?: "Failed to resolve pipeline status",
        )
      }

      val reason = when {
        stopRequested.remove(worker.pipelineId) -> "stopped"
        !status.error.isNullOrBlank() -> "error"
        else -> "completed"
      }

      val completion = StreamingPipelineCompletion(
        pipelineId = worker.pipelineId,
        reason = reason,
        chunksProcessed = status.chunksProcessed,
        unitsRead = status.unitsRead,
        unitsWritten = status.unitsWritten,
        error = status.error,
      )

      val callback = completionCallbacks.remove(worker.pipelineId)
      completionPoster {
        try {
          callback?.invoke(completion)
        } finally {
          remove(worker.pipelineId)
        }
      }
    }
  }

  fun get(pipelineId: String): StreamingPipelineWorker? = pipelines[pipelineId]

  fun stop(pipelineId: String) {
    val worker = pipelines[pipelineId] ?: return
    stopRequested.add(pipelineId)
    worker.stop()
  }

  fun flush(pipelineId: String): CompletableFuture<Unit> {
    val worker = pipelines[pipelineId]
      ?: return CompletableFuture<Unit>().also {
        it.completeExceptionally(IllegalArgumentException("Pipeline not found: $pipelineId"))
      }
    return worker.flush()
  }

  fun reset(pipelineId: String): CompletableFuture<Unit> {
    val worker = pipelines[pipelineId]
      ?: return CompletableFuture<Unit>().also {
        it.completeExceptionally(IllegalArgumentException("Pipeline not found: $pipelineId"))
      }
    return worker.reset()
  }

  fun getStatus(pipelineId: String): StreamingPipelineStatus? {
    return pipelines[pipelineId]?.getStatus()
  }

  fun remove(pipelineId: String) {
    pipelines.remove(pipelineId)?.release()
  }

  fun clear() {
    pipelines.values.forEach { it.release() }
    pipelines.clear()
    completionCallbacks.clear()
    stopRequested.clear()
  }
}
