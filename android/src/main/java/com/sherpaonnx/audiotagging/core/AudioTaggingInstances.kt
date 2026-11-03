package com.sherpaonnx.audiotagging.core

/** Kotlin-side bookkeeping for a JNI-held audio tagging engine (no AAR handle). */
internal data class AudioTaggingInstance(
  val instanceId: String,
  val defaultTopK: Int,
) {
  fun gateKey(): String = "audioTagging:$instanceId"
}
