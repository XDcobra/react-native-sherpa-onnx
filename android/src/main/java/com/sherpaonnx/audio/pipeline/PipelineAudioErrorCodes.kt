package com.sherpaonnx.audio.pipeline

/**
 * Unified error codes for the pipeline audio buffer subsystem.
 * Must match iOS and TypeScript.
 */
object PipelineAudioErrorCodes {
  const val BUFFER_NOT_FOUND = "AUDIO_BUFFER_NOT_FOUND"
  const val BUFFER_KIND_MISMATCH = "AUDIO_BUFFER_KIND_MISMATCH"
  const val INVALID_ARGUMENT = "AUDIO_INVALID_ARGUMENT"
  const val INVALID_STATE = "AUDIO_INVALID_STATE"
  const val FILE_NOT_FOUND = "AUDIO_FILE_NOT_FOUND"
  const val FILE_READ_ERROR = "AUDIO_FILE_READ_ERROR"
  const val FILE_WRITE_ERROR = "AUDIO_FILE_WRITE_ERROR"
  const val BUFFER_EMPTY = "AUDIO_BUFFER_EMPTY"
  const val SPOOL_NOT_AVAILABLE = "AUDIO_SPOOL_NOT_AVAILABLE"
  const val CAPTURE_ERROR = "AUDIO_CAPTURE_ERROR"
  const val ALREADY_FINALIZED = "AUDIO_ALREADY_FINALIZED"
  const val INTERNAL_ERROR = "AUDIO_INTERNAL_ERROR"
}
