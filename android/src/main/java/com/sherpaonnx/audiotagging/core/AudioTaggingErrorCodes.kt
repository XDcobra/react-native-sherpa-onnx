package com.sherpaonnx.audiotagging.core

internal object AudioTaggingErrorCodes {
  const val TAG = "SherpaOnnx:audioTagging"
  const val INIT_ERROR = "AUDIO_TAGGING_INIT_ERROR"
  const val NOT_INITIALIZED = "AUDIO_TAGGING_NOT_INITIALIZED"
  const val BUFFER_NOT_FOUND = "AUDIO_TAGGING_BUFFER_NOT_FOUND"
  const val BUFFER_EMPTY = "AUDIO_TAGGING_BUFFER_EMPTY"
  const val TAG_FAILED = "AUDIO_TAGGING_TAG_FAILED"
  const val INVALID_ARGUMENT = "AUDIO_TAGGING_INVALID_ARGUMENT"
  const val OFFLINE_OOM = "AUDIO_TAGGING_OFFLINE_OOM"
}
