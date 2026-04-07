package com.sherpaonnx

import android.net.Uri
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.k2fsa.sherpa.onnx.WaveReader
import java.io.File
import java.io.FileOutputStream
import java.util.ArrayList
import java.util.HashMap
import java.util.concurrent.Executors

internal class SherpaOnnxAlignmentHelper(
  private val context: ReactApplicationContext,
) {
  private val executor = Executors.newSingleThreadExecutor()

  fun shutdown() {
    executor.shutdownNow()
  }

  private external fun nativeCtcAlignAccurate(
    modelPath: String,
    text: String,
    vocabJson: String,
    samples: FloatArray,
    sampleRate: Int,
  ): HashMap<String, Any>

  fun alignAccurateFromPath(
    modelPath: String,
    audioPath: String,
    text: String,
    vocabJson: String,
    promise: Promise,
  ) {
    executor.execute {
      var cleanupPath: String? = null
      try {
        if (modelPath.isBlank()) {
          promise.reject("ALIGNMENT_ERROR", "modelPath is required")
          return@execute
        }
        if (audioPath.isBlank()) {
          promise.reject("ALIGNMENT_ERROR", "audioPath is required")
          return@execute
        }
        if (text.isBlank()) {
          promise.reject("ALIGNMENT_ERROR", "text is required")
          return@execute
        }

        val resolvedAudio = resolveAudioPath(audioPath)
        cleanupPath = resolvedAudio.second

        val file = File(resolvedAudio.first)
        if (!file.exists() || file.length() <= 0L) {
          promise.reject("ALIGNMENT_ERROR", "Audio file does not exist or is empty: ${resolvedAudio.first}")
          return@execute
        }

        val wave = WaveReader.readWave(resolvedAudio.first)
        val rawSamples = wave.samples ?: FloatArray(0)
        if (rawSamples.isEmpty()) {
          promise.reject("ALIGNMENT_ERROR", "Could not decode WAV samples from: ${resolvedAudio.first}")
          return@execute
        }

        val result = buildCtcAlignmentResult(modelPath, text, vocabJson, rawSamples, wave.sampleRate)
        promise.resolve(result)
      } catch (e: Exception) {
        Log.e("SherpaOnnxAlignment", "ALIGNMENT_ERROR: ${e.message}", e)
        promise.reject("ALIGNMENT_ERROR", e.message ?: "CTC alignment failed", e)
      } finally {
        if (cleanupPath != null) {
          try {
            File(cleanupPath).delete()
          } catch (_: Exception) {
            // ignore cleanup errors
          }
        }
      }
    }
  }

  fun alignAccurateFromFloat32(
    modelPath: String,
    samples: ReadableArray,
    sampleRate: Double,
    text: String,
    vocabJson: String,
    promise: Promise,
  ) {
    executor.execute {
      try {
        if (modelPath.isBlank()) {
          promise.reject("ALIGNMENT_ERROR", "modelPath is required")
          return@execute
        }
        if (text.isBlank()) {
          promise.reject("ALIGNMENT_ERROR", "text is required")
          return@execute
        }
        val sr = sampleRate.toInt()
        if (sr <= 0) {
          promise.reject("ALIGNMENT_ERROR", "sampleRate must be positive")
          return@execute
        }
        val raw = readableArrayToFloatArray(samples)
        if (raw.isEmpty()) {
          promise.reject("ALIGNMENT_ERROR", "samples array is empty")
          return@execute
        }
        val result = buildCtcAlignmentResult(modelPath, text, vocabJson, raw, sr)
        promise.resolve(result)
      } catch (e: Exception) {
        Log.e("SherpaOnnxAlignment", "ALIGNMENT_ERROR: ${e.message}", e)
        promise.reject("ALIGNMENT_ERROR", e.message ?: "CTC alignment failed", e)
      }
    }
  }

  fun getAlignmentAudioMetrics(
    audioPath: String,
    promise: Promise,
  ) {
    executor.execute {
      var cleanupPath: String? = null
      try {
        if (audioPath.isBlank()) {
          promise.reject("ALIGNMENT_ERROR", "audioPath is required")
          return@execute
        }
        val resolvedAudio = resolveAudioPath(audioPath)
        cleanupPath = resolvedAudio.second
        val metrics = WavAudioMetricsReader.readMetrics(resolvedAudio.first)
          ?: throw IllegalArgumentException(
            "Fast metrics require 16-bit mono PCM WAV. For other formats, decode in app code first.",
          )
        val map = Arguments.createMap()
        map.putInt("sampleRate", metrics.sampleRate)
        map.putInt("totalSamples", metrics.totalSamples)
        promise.resolve(map)
      } catch (e: Exception) {
        Log.e("SherpaOnnxAlignment", "ALIGNMENT_ERROR: ${e.message}", e)
        promise.reject("ALIGNMENT_ERROR", e.message ?: "Could not read WAV metrics", e)
      } finally {
        if (cleanupPath != null) {
          try {
            File(cleanupPath).delete()
          } catch (_: Exception) {
          }
        }
      }
    }
  }

  private fun readableArrayToFloatArray(samples: ReadableArray): FloatArray {
    val n = samples.size()
    val out = FloatArray(n)
    for (i in 0 until n) {
      out[i] = samples.getDouble(i).toFloat()
    }
    return out
  }

  private fun buildCtcAlignmentResult(
    modelPath: String,
    text: String,
    vocabJson: String,
    rawSamples: FloatArray,
    sourceSampleRate: Int,
  ): WritableMap {
    val raw = nativeCtcAlignAccurate(modelPath, text, vocabJson, rawSamples, sourceSampleRate)
    return alignmentResultToWritable(raw)
  }

  @Suppress("UNCHECKED_CAST")
  private fun alignmentResultToWritable(raw: HashMap<String, Any>): WritableMap {
    val words = raw["words"] as? ArrayList<HashMap<String, Any>>
      ?: throw IllegalStateException("native alignment: missing words")
    val chars = raw["chars"] as? ArrayList<HashMap<String, Any>>
      ?: throw IllegalStateException("native alignment: missing chars")
    val out = Arguments.createMap()
    out.putArray("words", alignmentItemsToWritableArray(words))
    out.putArray("chars", alignmentItemsToWritableArray(chars))
    return out
  }

  private fun alignmentItemsToWritableArray(items: ArrayList<HashMap<String, Any>>): WritableArray {
    val array = Arguments.createArray()
    for (item in items) {
      val map: WritableMap = Arguments.createMap()
      map.putString("text", item["text"] as? String ?: "")
      val start = item["start"] as? Double
      val end = item["end"] as? Double
      if (start != null) {
        map.putDouble("start", start)
      }
      if (end != null) {
        map.putDouble("end", end)
      }
      array.pushMap(map)
    }
    return array
  }

  private fun resolveAudioPath(audioPath: String): Pair<String, String?> {
    if (!audioPath.startsWith("content://")) {
      return Pair(audioPath, null)
    }

    val uri = Uri.parse(audioPath)
    val tempFile = File.createTempFile("alignment_input_", ".wav", context.cacheDir)
    context.contentResolver.openInputStream(uri)?.use { input ->
      FileOutputStream(tempFile).use { output ->
        input.copyTo(output)
      }
    } ?: throw IllegalStateException("Could not open content URI: $audioPath")

    return Pair(tempFile.absolutePath, tempFile.absolutePath)
  }
}
