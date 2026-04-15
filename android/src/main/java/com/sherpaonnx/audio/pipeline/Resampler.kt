package com.sherpaonnx.audio.pipeline

/**
 * Linear interpolation resampler shared across the pipeline audio subsystem.
 */
internal object Resampler {

  /**
   * Resample Float32 PCM via linear interpolation.
   * Returns the input unchanged if rates match.
   */
  fun resampleLinear(input: FloatArray, inputRate: Int, outputRate: Int): FloatArray {
    if (input.isEmpty() || inputRate <= 0 || outputRate <= 0 || inputRate == outputRate) {
      return input
    }

    val outputSize = kotlin.math.max(1, ((input.size.toLong() * outputRate) / inputRate).toInt())
    val out = FloatArray(outputSize)
    val ratio = inputRate.toDouble() / outputRate.toDouble()

    for (i in 0 until outputSize) {
      val src = i * ratio
      val left = src.toInt().coerceIn(0, input.lastIndex)
      val right = (left + 1).coerceAtMost(input.lastIndex)
      val frac = (src - left).toFloat()
      out[i] = input[left] + (input[right] - input[left]) * frac
    }

    return out
  }

  /**
   * Resample Int16 PCM via linear interpolation.
   * Returns the input unchanged if rates match.
   */
  fun resampleInt16(input: ShortArray, fromRate: Int, toRate: Int): ShortArray {
    if (fromRate == toRate) return input
    val ratio = fromRate.toDouble() / toRate
    val outLength = kotlin.math.round(input.size / ratio).toInt().coerceAtLeast(0)
    val result = ShortArray(outLength)
    for (i in 0 until outLength) {
      val srcIdx = i * ratio
      val idx0 = srcIdx.toInt().coerceIn(0, input.size - 1)
      val idx1 = (idx0 + 1).coerceAtMost(input.size - 1)
      val frac = (srcIdx - idx0).toFloat()
      val v0 = input[idx0].toInt()
      val v1 = input[idx1].toInt()
      result[i] = (v0 + (v1 - v0) * frac).toInt().toShort()
    }
    return result
  }
}
