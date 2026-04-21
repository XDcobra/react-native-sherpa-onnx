package com.sherpaonnx.text.pipeline

/**
 * Typed runtime failure for text pipeline operations that need a stable error code.
 */
class TextPipelineException(
  val code: String,
  override val message: String,
  cause: Throwable? = null
) : RuntimeException(message, cause)
