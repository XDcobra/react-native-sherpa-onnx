package com.sherpaonnx.enhancement.core

import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiser
import com.k2fsa.sherpa.onnx.OnlineSpeechDenoiser

internal data class EnhancementInstance(
  @Volatile var denoiser: OfflineSpeechDenoiser? = null,
) {
  fun release() {
    denoiser?.release()
    denoiser = null
  }
}

internal data class OnlineEnhancementInstance(
  @Volatile var denoiser: OnlineSpeechDenoiser? = null,
) {
  fun release() {
    denoiser?.release()
    denoiser = null
  }
}