package com.sherpaonnx.audio.pipeline

import java.util.concurrent.CompletableFuture

data class StreamingPipelineStatus(
  val isRunning: Boolean,
  val chunksProcessed: Long,
  val unitsRead: Long,
  val unitsWritten: Long,
  val error: String? = null,
)

data class StreamingPipelineCompletion(
  val pipelineId: String,
  val reason: String,
  val chunksProcessed: Long,
  val unitsRead: Long,
  val unitsWritten: Long,
  val error: String? = null,
)

interface StreamingPipelineWorker {
  val pipelineId: String
  val isRunning: Boolean

  fun start()

  fun stop()

  fun flush(): CompletableFuture<Unit>

  fun reset(): CompletableFuture<Unit>

  fun getStatus(): StreamingPipelineStatus

  fun release()
}
