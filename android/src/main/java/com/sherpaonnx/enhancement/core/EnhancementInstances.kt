package com.sherpaonnx.enhancement.core

internal data class EnhancementInstance(
  val instanceId: String,
) {
  fun gateKey(): String = "enhancement:$instanceId"
}

internal data class OnlineEnhancementInstance(
  val instanceId: String,
) {
  fun gateKey(): String = "online-enhancement:$instanceId"
}

internal data class NativeEnhanceAudio(
  val samples: FloatArray,
  val sampleRate: Int,
)
