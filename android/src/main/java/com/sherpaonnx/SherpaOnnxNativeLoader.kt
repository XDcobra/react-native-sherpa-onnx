package com.sherpaonnx

import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Loads sherpa-onnx native libraries without requiring [SherpaOnnxModule] / React Native init.
 * Used by Android [android.speech.tts.TextToSpeechService] and other non-bridge entry points.
 */
object SherpaOnnxNativeLoader {
  private val loaded = AtomicBoolean(false)

  @JvmStatic
  @Synchronized
  fun ensureLoaded() {
    if (loaded.get()) {
      return
    }
    try {
      System.loadLibrary("onnxruntime")
    } catch (e: UnsatisfiedLinkError) {
      Log.w("SherpaOnnx", "onnxruntime not loaded (will use SDK copy if present): ${e.message}")
    }
    try {
      System.loadLibrary("sherpa-onnx-jni")
    } catch (e: UnsatisfiedLinkError) {
      throw RuntimeException(
        "Failed to load sherpa-onnx-jni (from sherpa-onnx AAR): ${e.message}",
        e
      )
    }
    try {
      System.loadLibrary("sherpa-onnx-c-api")
    } catch (e: UnsatisfiedLinkError) {
      Log.w(
        "SherpaOnnx",
        "sherpa-onnx-c-api not available — Zipvoice TTS will not work: ${e.message}"
      )
    }
    System.loadLibrary("sherpaonnx")
    loaded.set(true)
  }
}
