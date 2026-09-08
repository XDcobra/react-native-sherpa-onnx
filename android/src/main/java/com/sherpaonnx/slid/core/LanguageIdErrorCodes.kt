package com.sherpaonnx.slid.core

object LanguageIdErrorCodes {
  const val TAG = "SherpaOnnxLanguageId"

  const val INIT_ERROR = "LANGUAGE_ID_INIT_ERROR"
  const val DETECT_ERROR = "LANGUAGE_ID_DETECT_ERROR"
  const val IDENTIFY_FAILED = "LANGUAGE_ID_IDENTIFY_FAILED"
  const val NOT_INITIALIZED = "LANGUAGE_ID_NOT_INITIALIZED"
  const val BUFFER_NOT_FOUND = "LANGUAGE_ID_AUDIO_BUFFER_NOT_FOUND"
  const val BUFFER_EMPTY = "LANGUAGE_ID_AUDIO_BUFFER_EMPTY"
  const val OFFLINE_OOM = "OFFLINE_OOM"
}
