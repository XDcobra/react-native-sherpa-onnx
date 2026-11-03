package com.sherpaonnx.slid.core

/** Kotlin-side bookkeeping for a JNI-held SLID engine (no AAR handle). */
internal data class LanguageIdInstance(
  val instanceId: String,
) {
  fun gateKey(): String = "slid:$instanceId"
}
