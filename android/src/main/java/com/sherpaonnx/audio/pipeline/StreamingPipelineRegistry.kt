package com.sherpaonnx.audio.pipeline

import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap

object StreamingPipelineRegistry {
  private val pipelines = ConcurrentHashMap<String, StreamingPipelineWorker>()

  fun registerAndStart(worker: StreamingPipelineWorker): String {
    pipelines[worker.pipelineId] = worker
    worker.start()
    return worker.pipelineId
  }

  fun get(pipelineId: String): StreamingPipelineWorker? = pipelines[pipelineId]

  fun stop(pipelineId: String) {
    pipelines[pipelineId]?.stop()
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
  }
}
