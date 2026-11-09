package com.sherpaonnx.tts.nativeapi

/**
 * JNI progress bridge for batch TTS generate-with-callback.
 * Return `1` to continue, `0` to cancel generation.
 */
fun interface TtsGenerateProgressCallback {
  fun onProgress(progress: Float): Int
}
