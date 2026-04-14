package com.sherpaonnx.alignment.core

import com.facebook.react.bridge.Promise

internal object AlignmentPromiseUtils {
  fun rejectWithEmbeddedCode(
    promise: Promise,
    fallbackCode: String,
    rawMessage: String,
    error: Throwable? = null,
  ) {
    val message = rawMessage.trim()
    val embeddedCode = message.substringBefore(':').trim()
    val code = if (embeddedCode.startsWith("ALIGNMENT_")) {
      embeddedCode
    } else {
      fallbackCode
    }
    promise.reject(code, message, error)
  }
}
