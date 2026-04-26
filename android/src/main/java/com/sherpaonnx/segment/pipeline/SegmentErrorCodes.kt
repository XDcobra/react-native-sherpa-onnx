package com.sherpaonnx.segment.pipeline

object SegmentErrorCodes {
  const val BUFFER_NOT_FOUND = "SEGMENT_BUFFER_NOT_FOUND"
  const val BUFFER_KIND_MISMATCH = "SEGMENT_BUFFER_KIND_MISMATCH"
  const val INVALID_ARGUMENT = "SEGMENT_INVALID_ARGUMENT"
  const val INVALID_STATE = "SEGMENT_INVALID_STATE"
  const val ALREADY_FINALIZED = "SEGMENT_ALREADY_FINALIZED"
  const val SLICE_INVALID = "SEGMENT_SLICE_INVALID"
  const val INTERNAL_ERROR = "SEGMENT_INTERNAL_ERROR"

  const val SPOOL_UNAVAILABLE = "SEGMENT_SPOOL_UNAVAILABLE"
  const val SPOOL_WRITE_FAILED = "SEGMENT_SPOOL_WRITE_FAILED"
  const val SPOOL_READ_FAILED = "SEGMENT_SPOOL_READ_FAILED"
  const val SPOOL_CORRUPTED = "SEGMENT_SPOOL_CORRUPTED"
}

class SegmentPipelineException(
  val code: String,
  override val message: String,
  cause: Throwable? = null,
) : RuntimeException(message, cause)
