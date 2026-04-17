package com.sherpaonnx.audio.pipeline

import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap

private const val PIPELINE_COMPLETION_POLL_MS = 20L

object StreamingPipelineRegistry {
  private val pipelines = ConcurrentHashMap<String, StreamingPipelineWorker>()
  private val completionCallbacks =
    ConcurrentHashMap<String, (StreamingPipelineCompletion) -> Unit>()
  private val stopRequested = ConcurrentHashMap.newKeySet<String>()

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

      try {
        completionCallbacks.remove(worker.pipelineId)?.invoke(completion)
      } finally {
        remove(worker.pipelineId)
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
