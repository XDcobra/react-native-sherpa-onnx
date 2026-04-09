package com.sherpaonnx

import android.media.MediaExtractor
import android.net.Uri
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.k2fsa.sherpa.onnx.WaveReader
import java.io.File
import java.io.FileOutputStream
import java.util.ArrayList
import java.util.HashMap
import java.util.concurrent.Executors
import kotlin.math.roundToInt

internal data class AlignmentTtsSinkSnapshot(
  val samples: FloatArray,
  val sampleRate: Int,
  val numSamples: Int,
)

internal class SherpaOnnxAlignmentHelper(
  private val context: ReactApplicationContext,
  private val getTtsSinkSnapshot: (instanceId: String, generation: Long) -> AlignmentTtsSinkSnapshot,
) {
  private val executor = Executors.newSingleThreadExecutor()

  fun shutdown() {
    executor.shutdownNow()
  }

  private external fun nativeAlignProportional(
    text: String,
    totalSamples: Int,
    sampleRate: Int,
    granularity: String,
  ): HashMap<String, Any>

  private external fun nativeAlignEstimated(
    text: String,
    segmentSampleCounts: IntArray,
    sampleRate: Int,
    granularity: String,
  ): HashMap<String, Any>

  private external fun nativeAlignAccurateFromFloatPcm(
    modelPath: String,
    text: String,
    samples: FloatArray,
    sampleRate: Int,
    granularity: String,
  ): HashMap<String, Any>

  private external fun nativeAlignAccurateFromFile(
    modelPath: String,
    text: String,
    audioPath: String,
    granularity: String,
  ): HashMap<String, Any>

  fun alignTextToAudioFromPath(
    text: String,
    audioPath: String,
    mode: String,
    granularity: String,
    options: ReadableMap?,
    promise: Promise,
  ) {
    executor.execute {
      var cleanupPath: String? = null
      try {
        if (text.isBlank()) {
          promise.reject("ALIGNMENT_ERROR", "text is required")
          return@execute
        }
        if (audioPath.isBlank()) {
          promise.reject("ALIGNMENT_ERROR", "audioPath is required")
          return@execute
        }

        val resolved = resolveAudioPath(audioPath)
        cleanupPath = resolved.second
        val normalizedMode = normalizeMode(mode)
        val normalizedGranularity = normalizeGranularity(granularity)

        val raw = when (normalizedMode) {
          "proportional" -> {
            val (sampleRate, totalSamples) = readAudioDuration(resolved.first)
            nativeAlignProportional(text, totalSamples, sampleRate, normalizedGranularity)
          }
          "estimated" -> {
            val fallbackRate = readAudioDuration(resolved.first).first
            val sampleRate = parseEstimatedSampleRate(options, fallbackRate)
            val counts = parseSegmentSampleCounts(options)
            nativeAlignEstimated(text, counts, sampleRate, normalizedGranularity)
          }
          "accurate" -> {
            val modelPath = parseAlignmentModelPath(options)
            nativeAlignAccurateFromFile(
              modelPath,
              text,
              resolved.first,
              normalizedGranularity,
            )
          }
          else -> throw IllegalArgumentException("Unsupported alignment mode: $normalizedMode")
        }

        promise.resolve(alignmentResultToWritable(raw))
      } catch (e: Exception) {
        Log.e("SherpaOnnxAlignment", "ALIGNMENT_ERROR: ${e.message}", e)
        promise.reject("ALIGNMENT_ERROR", e.message ?: "Alignment failed", e)
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

  fun alignTextToAudioFromPcm(
    text: String,
    samples: ReadableArray,
    sampleRate: Double,
    mode: String,
    granularity: String,
    options: ReadableMap?,
    promise: Promise,
  ) {
    executor.execute {
      try {
        if (text.isBlank()) {
          promise.reject("ALIGNMENT_ERROR", "text is required")
          return@execute
        }

        val sr = sampleRate.toInt()
        if (sr <= 0) {
          promise.reject("ALIGNMENT_ERROR", "sampleRate must be positive")
          return@execute
        }

        val normalizedMode = normalizeMode(mode)
        val normalizedGranularity = normalizeGranularity(granularity)
        val rawSamples = readableArrayToFloatArray(samples)

        if (rawSamples.isEmpty()) {
          promise.reject("ALIGNMENT_ERROR", "samples array is empty")
          return@execute
        }

        val raw = when (normalizedMode) {
          "proportional" -> nativeAlignProportional(
            text,
            rawSamples.size,
            sr,
            normalizedGranularity,
          )
          "estimated" -> {
            val estimatedRate = parseEstimatedSampleRate(options, sr)
            val counts = parseSegmentSampleCounts(options)
            nativeAlignEstimated(text, counts, estimatedRate, normalizedGranularity)
          }
          "accurate" -> {
            val modelPath = parseAlignmentModelPath(options)
            nativeAlignAccurateFromFloatPcm(
              modelPath,
              text,
              rawSamples,
              sr,
              normalizedGranularity,
            )
          }
          else -> throw IllegalArgumentException("Unsupported alignment mode: $normalizedMode")
        }

        promise.resolve(alignmentResultToWritable(raw))
      } catch (e: Exception) {
        Log.e("SherpaOnnxAlignment", "ALIGNMENT_ERROR: ${e.message}", e)
        promise.reject("ALIGNMENT_ERROR", e.message ?: "Alignment failed", e)
      }
    }
  }

  fun alignTextToTtsSink(
    generatedAudio: ReadableMap,
    text: String,
    mode: String,
    granularity: String,
    options: ReadableMap?,
    promise: Promise,
  ) {
    executor.execute {
      try {
        if (text.isBlank()) {
          promise.reject("ALIGNMENT_ERROR", "text is required")
          return@execute
        }

        val instanceId = generatedAudio.getString("_instanceId")?.trim()
          ?: generatedAudio.getString("instanceId")?.trim()
          ?: ""
        if (instanceId.isBlank()) {
          promise.reject(
            "ALIGNMENT_ERROR",
            "generatedAudio._instanceId is required",
          )
          return@execute
        }

        if (!generatedAudio.hasKey("generation")) {
          promise.reject("ALIGNMENT_ERROR", "generatedAudio.generation is required")
          return@execute
        }
        val generation = generatedAudio.getDouble("generation").toLong()
        if (generation <= 0L) {
          promise.reject("ALIGNMENT_ERROR", "generatedAudio.generation must be > 0")
          return@execute
        }

        val snapshot = getTtsSinkSnapshot(instanceId, generation)
        val normalizedMode = normalizeMode(mode)
        val normalizedGranularity = normalizeGranularity(granularity)

        val raw = when (normalizedMode) {
          "proportional" -> nativeAlignProportional(
            text,
            snapshot.numSamples,
            snapshot.sampleRate,
            normalizedGranularity,
          )
          "estimated" -> {
            val estimatedRate = parseEstimatedSampleRate(options, snapshot.sampleRate)
            val counts = parseSegmentSampleCounts(options)
            nativeAlignEstimated(
              text,
              counts,
              estimatedRate,
              normalizedGranularity,
            )
          }
          "accurate" -> {
            val modelPath = parseAlignmentModelPath(options)
            nativeAlignAccurateFromFloatPcm(
              modelPath,
              text,
              snapshot.samples,
              snapshot.sampleRate,
              normalizedGranularity,
            )
          }
          else -> throw IllegalArgumentException("Unsupported alignment mode: $normalizedMode")
        }

        promise.resolve(alignmentResultToWritable(raw))
      } catch (e: Exception) {
        Log.e("SherpaOnnxAlignment", "ALIGNMENT_ERROR: ${e.message}", e)
        promise.reject("ALIGNMENT_ERROR", e.message ?: "Alignment failed", e)
      }
    }
  }

  fun getAudioDuration(
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
        val metrics = readAudioDuration(resolvedAudio.first)

        val map = Arguments.createMap()
        map.putInt("sampleRate", metrics.first)
        map.putInt("totalSamples", metrics.second)
        promise.resolve(map)
      } catch (e: Exception) {
        Log.e("SherpaOnnxAlignment", "ALIGNMENT_ERROR: ${e.message}", e)
        promise.reject("ALIGNMENT_ERROR", e.message ?: "Could not read audio duration", e)
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

  private fun normalizeMode(mode: String): String {
    val normalized = mode.trim().lowercase()
    return when (normalized) {
      "proportional", "estimated", "accurate" -> normalized
      else -> throw IllegalArgumentException("Unsupported alignment mode: $mode")
    }
  }

  private fun normalizeGranularity(granularity: String): String {
    val normalized = granularity.trim().lowercase()
    return when (normalized) {
      "", "sentence" -> "sentence"
      "word" -> "word"
      "character" -> "character"
      else -> throw IllegalArgumentException("Unsupported alignment granularity: $granularity")
    }
  }

  private fun parseAlignmentModelPath(options: ReadableMap?): String {
    val p = options?.getString("alignmentModelPath")?.trim().orEmpty()
    if (p.isBlank()) {
      throw IllegalArgumentException(
        "ALIGNMENT_MODEL_MISSING: Provide options.alignmentModelPath for accurate alignment.",
      )
    }
    return p
  }

  private fun parseSegmentSampleCounts(options: ReadableMap?): IntArray {
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

  private fun parseEstimatedSampleRate(
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

  private fun readableArrayToFloatArray(samples: ReadableArray): FloatArray {
    val n = samples.size()
    val out = FloatArray(n)
    for (i in 0 until n) {
      out[i] = samples.getDouble(i).toFloat()
    }
    return out
  }

  @Suppress("UNCHECKED_CAST")
  private fun alignmentResultToWritable(raw: HashMap<String, Any>): WritableMap {
    val subtitles = raw["subtitles"] as? ArrayList<HashMap<String, Any>>
      ?: throw IllegalStateException("native alignment: missing subtitles")
    val timingMode = raw["timingMode"] as? String
      ?: throw IllegalStateException("native alignment: missing timingMode")

    val out = Arguments.createMap()
    out.putArray("subtitles", alignmentItemsToWritableArray(subtitles))
    out.putString("timingMode", timingMode)
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

  private fun readAudioDuration(path: String): Pair<Int, Int> {
    val wavMetrics = WavAudioMetricsReader.readMetrics(path)
    if (wavMetrics != null && wavMetrics.sampleRate > 0 && wavMetrics.totalSamples >= 0) {
      return Pair(wavMetrics.sampleRate, wavMetrics.totalSamples)
    }

    val extractor = MediaExtractor()
    try {
      extractor.setDataSource(path)
      for (i in 0 until extractor.trackCount) {
        val format = extractor.getTrackFormat(i)
        val mime = format.getString(android.media.MediaFormat.KEY_MIME) ?: ""
        if (!mime.startsWith("audio/")) {
          continue
        }

        val sampleRate = if (format.containsKey(android.media.MediaFormat.KEY_SAMPLE_RATE)) {
          format.getInteger(android.media.MediaFormat.KEY_SAMPLE_RATE)
        } else {
          0
        }
        val durationUs = if (format.containsKey(android.media.MediaFormat.KEY_DURATION)) {
          format.getLong(android.media.MediaFormat.KEY_DURATION)
        } else {
          0L
        }

        if (sampleRate > 0 && durationUs > 0L) {
          val totalSamples = (durationUs.toDouble() / 1_000_000.0 * sampleRate.toDouble()).roundToInt()
          return Pair(sampleRate, totalSamples.coerceAtLeast(0))
        }
      }
    } catch (_: Exception) {
      // fall through to decode fallback
    } finally {
      try {
        extractor.release()
      } catch (_: Exception) {
      }
    }

    val wave = WaveReader.readWave(path)
    val sr = wave.sampleRate
    val total = wave.samples?.size ?: 0
    if (sr <= 0 || total <= 0) {
      throw IllegalStateException("Could not read audio duration from: $path")
    }
    return Pair(sr, total)
  }
}
