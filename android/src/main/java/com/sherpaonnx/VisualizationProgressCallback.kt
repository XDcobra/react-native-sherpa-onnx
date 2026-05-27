package com.sherpaonnx

/**
 * JNI callback for visualization ingest progress (decode + STFT analysis).
 * Implemented by Kotlin and invoked from native C++ via JNI.
 */
fun interface VisualizationProgressCallback {
  fun onVisualizationProgress(
    phase: String,
    phasePercent: Double,
    framesDecoded: Long,
    totalFramesEstimate: Long,
    stftWindowsDone: Long,
    stftWindowsTotal: Long,
  )
}
