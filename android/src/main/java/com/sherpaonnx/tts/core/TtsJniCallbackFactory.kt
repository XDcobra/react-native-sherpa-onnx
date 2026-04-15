package com.sherpaonnx.tts.core

import java.util.concurrent.atomic.AtomicBoolean

/**
 * libsherpa-onnx-jni looks up `invoke([F)Ljava/lang/Integer` (see sherpa-onnx `offline-tts.cc` CallCallback).
 * Kotlin `Function1<*, Int>` compiles to `invoke([F)I`, so GetMethodID fails and JNI aborts.
 * Using [java.lang.Integer] as the type parameter yields the boxed JVM signature the JNI expects.
 * The cast is only for the Kotlin API (`generateWithCallback` still declares `Function1<FloatArray, Int>`).
 */
internal object TtsJniCallbackFactory {
  /** Box for JNI: must be real [java.lang.Integer], not Kotlin [Int] (primitive `invoke([F)I` breaks sherpa JNI). */
  @Suppress("DEPRECATION")
  fun boxForTtsJni(n: Int): java.lang.Integer = java.lang.Integer(n)

  @Suppress("UNCHECKED_CAST")
  fun ttsStreamChunkCallbackForJni(
    cancelled: AtomicBoolean,
    onChunk: (FloatArray) -> Unit
  ): kotlin.Function1<FloatArray, Int> {
    val boxed =
      object : kotlin.jvm.functions.Function1<FloatArray, java.lang.Integer> {
        override fun invoke(chunk: FloatArray): java.lang.Integer {
          if (cancelled.get()) return boxForTtsJni(0)
          onChunk(chunk)
          return boxForTtsJni(chunk.size)
        }
      }
    return boxed as kotlin.Function1<FloatArray, Int>
  }
}
