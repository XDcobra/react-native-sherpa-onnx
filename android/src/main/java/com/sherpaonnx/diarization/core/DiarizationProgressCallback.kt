package com.sherpaonnx.diarization.core

/**
 * JNI progress bridge for offline diarization. Called on the thread that runs
 * the native process call; `phase` is "segmentation", "embedding" or "clustering".
 */
fun interface DiarizationProgressCallback {
  fun onProgress(fraction: Float, phase: String, current: Int, total: Int)
}
