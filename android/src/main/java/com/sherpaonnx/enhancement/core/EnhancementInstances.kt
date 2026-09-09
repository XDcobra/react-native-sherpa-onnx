package com.sherpaonnx.enhancement.core

import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiser
import com.k2fsa.sherpa.onnx.OnlineSpeechDenoiser
import com.sherpaonnx.lifecycle.NativeInstanceGate

internal data class EnhancementInstance(
  @Volatile var denoiser: OfflineSpeechDenoiser? = null,
) {
  fun release() {
    val eng = denoiser
    denoiser = null
    if (eng == null) return
    NativeInstanceGate.releaseWhenIdle(NativeInstanceGate.keyFor(eng)) {
      try {
        eng.release()
      } catch (_: Exception) {
      }
    }
  }
}

internal data class OnlineEnhancementInstance(
  @Volatile var denoiser: OnlineSpeechDenoiser? = null,
) {
  fun release() {
    val eng = denoiser
    denoiser = null
    if (eng == null) return
    NativeInstanceGate.releaseWhenIdle(NativeInstanceGate.keyFor(eng)) {
      try {
        eng.release()
      } catch (_: Exception) {
      }
    }
  }
}
