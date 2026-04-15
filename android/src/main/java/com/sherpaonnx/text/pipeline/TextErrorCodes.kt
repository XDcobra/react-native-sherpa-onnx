package com.sherpaonnx.text.pipeline

/**
 * Error codes for text pipeline buffer operations. Must match iOS and TypeScript.
 */
object TextErrorCodes {
  const val BUFFER_NOT_FOUND = "TEXT_BUFFER_NOT_FOUND"
  const val BUFFER_KIND_MISMATCH = "TEXT_BUFFER_KIND_MISMATCH"
  const val INVALID_ARGUMENT = "TEXT_INVALID_ARGUMENT"
  const val INVALID_STATE = "TEXT_INVALID_STATE"
  const val BUFFER_EMPTY = "TEXT_BUFFER_EMPTY"
  const val ALREADY_FINALIZED = "TEXT_ALREADY_FINALIZED"
  const val ALREADY_POPULATED = "TEXT_ALREADY_POPULATED"
  const val SLICE_INVALID = "TEXT_SLICE_INVALID"
  const val SLICE_TOO_LARGE = "TEXT_SLICE_TOO_LARGE"
  const val INTERNAL_ERROR = "TEXT_INTERNAL_ERROR"

  const val TEXT_DEFAULT_SLICE_COUNT = 1024
  const val TEXT_MAX_SLICE_COUNT = 16384
}
