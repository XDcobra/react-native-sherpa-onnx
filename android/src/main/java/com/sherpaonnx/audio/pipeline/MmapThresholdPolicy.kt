package com.sherpaonnx.audio.pipeline

internal enum class ThresholdPathType {
  FILE_ORIGIN,
  HEAP_ORIGIN,
}

/**
 * Size above which an offline buffer is file-backed (mmap) instead of held in memory.
 *
 * The native audio registry owns the policy (RAM class from `nativeInit`); Kotlin asks it,
 * so buffers created from Kotlin and from native code are stored alike.
 */
internal object MmapThresholdPolicy {
  fun thresholdBytes(pathType: ThresholdPathType): Long =
    AudioBufferNative.nativeThresholdBytes(pathType == ThresholdPathType.FILE_ORIGIN)
}
