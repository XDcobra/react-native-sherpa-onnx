package com.sherpaonnx.alignment.core

import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap

internal object AlignmentOptionParsers {
  fun normalizeMode(mode: String): String {
    val normalized = mode.trim().lowercase()
    return when (normalized) {
      "proportional", "estimated", "accurate" -> normalized
      else -> throw IllegalArgumentException("Unsupported alignment mode: $mode")
    }
  }

  fun normalizeGranularity(granularity: String): String {
    val normalized = granularity.trim().lowercase()
    return when (normalized) {
      "", "sentence" -> "sentence"
      "word" -> "word"
      "character" -> "character"
      else -> throw IllegalArgumentException("Unsupported alignment granularity: $granularity")
    }
  }

  fun parseAlignmentModelPath(options: ReadableMap?): String {
    val p = options?.getString("alignmentModelPath")?.trim().orEmpty()
    if (p.isBlank()) {
      throw IllegalArgumentException(
        "ALIGNMENT_MODEL_MISSING: Provide options.alignmentModelPath for accurate alignment.",
      )
    }
    return p
  }

  fun parseSegmentSampleCounts(options: ReadableMap?): IntArray {
    val direct = options?.getArray("segmentSampleCounts")
    if (direct != null) {
      return readableArrayToIntArray(direct)
    }

    val chunks = options?.getMap("chunks")
    val nested = chunks?.getArray("segmentSampleCounts")
    if (nested != null) {
      return readableArrayToIntArray(nested)
    }

    throw IllegalArgumentException(
      "ALIGNMENT_CHUNKS_MISSING: Provide options.segmentSampleCounts (or options.chunks.segmentSampleCounts) for estimated mode.",
    )
  }

  fun parseEstimatedSampleRate(
    options: ReadableMap?,
    fallbackSampleRate: Int,
  ): Int {
    val direct = if (options?.hasKey("sampleRate") == true) {
      options.getDouble("sampleRate")
    } else {
      Double.NaN
    }
    if (direct.isFinite() && direct > 0.0) {
      return direct.toInt()
    }

    val nested = options?.getMap("chunks")
    if (nested?.hasKey("sampleRate") == true) {
      val value = nested.getDouble("sampleRate")
      if (value.isFinite() && value > 0.0) {
        return value.toInt()
      }
    }

    return fallbackSampleRate
  }

  private fun readableArrayToIntArray(array: ReadableArray): IntArray {
    val n = array.size()
    val out = IntArray(n)
    for (i in 0 until n) {
      out[i] = if (array.isNull(i)) {
        0
      } else {
        val v = array.getDouble(i)
        if (v.isFinite()) {
          if (v <= Int.MIN_VALUE.toDouble()) Int.MIN_VALUE
          else if (v >= Int.MAX_VALUE.toDouble()) Int.MAX_VALUE
          else v.toInt()
        } else {
          0
        }
      }
      if (out[i] < 0) {
        out[i] = 0
      }
    }
    return out
  }
}
