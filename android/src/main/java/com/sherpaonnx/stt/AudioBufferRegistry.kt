package com.sherpaonnx.stt

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.k2fsa.sherpa.onnx.WaveReader
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Retained PCM audio buffer for pipeline stages (STT, alignment, enhancement).
 */
data class AudioBuffer(
  val bufferId: String,
  val kind: String = "offlinePcmBuffer",
  val samples: FloatArray,
  val sampleRate: Int,
  val channelCount: Int
) {
  val numSamples: Int get() = samples.size
  val durationMs: Double get() = if (sampleRate > 0) (samples.size.toDouble() / sampleRate) * 1000.0 else 0.0

  fun toWritableMap(): WritableMap {
    val map = Arguments.createMap()
    map.putString("bufferId", bufferId)
    map.putString("kind", kind)
    map.putDouble("sampleRate", sampleRate.toDouble())
    map.putInt("channelCount", channelCount)
    map.putInt("numSamples", numSamples)
    map.putDouble("durationMs", durationMs)
    return map
  }
}

/**
 * Shared audio buffer registry. Thread-safe via ConcurrentHashMap.
 */
object AudioBufferRegistry {
  private val buffers = ConcurrentHashMap<String, AudioBuffer>()

  private fun resampleLinear(input: FloatArray, inputRate: Int, outputRate: Int): FloatArray {
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

  fun createFromFile(
    filePath: String,
    targetSampleRateHz: Int? = null,
    forceMono: Boolean? = null
  ): AudioBuffer {
    val file = File(filePath)
    if (!file.exists()) throw IllegalArgumentException("Audio file does not exist: $filePath")
    if (file.length() == 0L) throw IllegalArgumentException("Audio file is empty: $filePath")

    val wave = WaveReader.readWave(filePath)
    val sourceSamples = wave.samples ?: FloatArray(0)
    if (sourceSamples.isEmpty()) {
      throw IllegalArgumentException("Could not read audio samples from: $filePath")
    }

    if (targetSampleRateHz != null && targetSampleRateHz <= 0) {
      throw IllegalArgumentException("targetSampleRateHz must be > 0, got: $targetSampleRateHz")
    }

    val outputSampleRate = targetSampleRateHz ?: wave.sampleRate
    val outputSamples = if (outputSampleRate != wave.sampleRate) {
      resampleLinear(sourceSamples, wave.sampleRate, outputSampleRate)
    } else {
      sourceSamples
    }

    val bufferId = "buf_${UUID.randomUUID()}"
    val buffer = AudioBuffer(
      bufferId = bufferId,
      samples = outputSamples,
      sampleRate = outputSampleRate,
      channelCount = if (forceMono == true) 1 else 1 // WaveReader always returns mono
    )
    buffers[bufferId] = buffer
    return buffer
  }

  fun get(bufferId: String): AudioBuffer? = buffers[bufferId]

  fun release(bufferId: String): Boolean {
    return buffers.remove(bufferId) != null
  }

  fun clear() {
    buffers.clear()
  }
}
