package com.sherpaonnx

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.sherpaonnx.audio.pipeline.OfflineEntry
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.text.pipeline.TextPipelineRegistry
import java.util.ArrayList
import java.util.HashMap
import java.util.concurrent.Executors

internal data class SttAlignmentSegment(
  val text: String,
  val startSec: Double,
  val endSec: Double,
)

internal class SherpaOnnxAlignmentHelper {
  companion object {
    private const val TAG = "SherpaOnnxAlignment"

    private const val ERR_ALIGNMENT = "ALIGNMENT_ERROR"
    private const val ERR_TEXT_NOT_FOUND = "ALIGNMENT_TEXT_BUFFER_NOT_FOUND"
    private const val ERR_TEXT_KIND_MISMATCH = "ALIGNMENT_TEXT_BUFFER_KIND_MISMATCH"
    private const val ERR_TEXT_EMPTY = "ALIGNMENT_TEXT_BUFFER_EMPTY"
    private const val ERR_AUDIO_NOT_FOUND = "ALIGNMENT_AUDIO_BUFFER_NOT_FOUND"
    private const val ERR_AUDIO_KIND_MISMATCH = "ALIGNMENT_AUDIO_BUFFER_KIND_MISMATCH"
    private const val ERR_AUDIO_EMPTY = "ALIGNMENT_AUDIO_BUFFER_EMPTY"
  }

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

  fun alignOfflineTextToAudio(
    textInBufferId: String,
    audioInBufferId: String,
    mode: String,
    granularity: String,
    options: ReadableMap?,
    promise: Promise,
  ) {
    executor.execute {
      try {
        val textId = textInBufferId.trim()
        if (textId.isEmpty()) {
          promise.reject(ERR_TEXT_NOT_FOUND, "textInBufferId is required")
          return@execute
        }
        if (!textId.startsWith("txt_off_")) {
          promise.reject(
            ERR_TEXT_KIND_MISMATCH,
            "Expected offline text buffer (txt_off_*), got: $textInBufferId",
          )
          return@execute
        }

        val textEntry = TextPipelineRegistry.getOffline(textId)
        if (textEntry == null) {
          if (TextPipelineRegistry.getLive(textId) != null) {
            promise.reject(
              ERR_TEXT_KIND_MISMATCH,
              "Expected offline text buffer (txt_off_*), got live buffer: $textInBufferId",
            )
          } else {
            promise.reject(
              ERR_TEXT_NOT_FOUND,
              "Offline text buffer not found: $textInBufferId",
            )
          }
          return@execute
        }

        val text = textEntry.text
        if (!textEntry.populated || text.isBlank()) {
          promise.reject(
            ERR_TEXT_EMPTY,
            "Offline text buffer is empty or not populated: $textInBufferId",
          )
          return@execute
        }

        val audioId = audioInBufferId.trim()
        if (audioId.isEmpty()) {
          promise.reject(ERR_AUDIO_NOT_FOUND, "audioInBufferId is required")
          return@execute
        }
        if (!audioId.startsWith("off_")) {
          promise.reject(
            ERR_AUDIO_KIND_MISMATCH,
            "Expected offline audio buffer (off_*), got: $audioInBufferId",
          )
          return@execute
        }

        val audioEntry = PipelineAudioRegistry.getOffline(audioId)
        if (audioEntry == null) {
          if (PipelineAudioRegistry.getLive(audioId) != null) {
            promise.reject(
              ERR_AUDIO_KIND_MISMATCH,
              "Expected offline audio buffer (off_*), got live buffer: $audioInBufferId",
            )
          } else {
            promise.reject(
              ERR_AUDIO_NOT_FOUND,
              "Offline audio buffer not found: $audioInBufferId",
            )
          }
          return@execute
        }

        if (audioEntry.sampleRate <= 0 || audioEntry.numSamples <= 0) {
          promise.reject(
            ERR_AUDIO_EMPTY,
            "Offline audio buffer is empty: $audioInBufferId",
          )
          return@execute
        }

        val normalizedMode = normalizeMode(mode)
        val normalizedGranularity = normalizeGranularity(granularity)

        val raw = when (normalizedMode) {
          "proportional" -> nativeAlignProportional(
            text,
            audioEntry.numSamples,
            audioEntry.sampleRate,
            normalizedGranularity,
          )

          "estimated" -> {
            val estimatedRate = parseEstimatedSampleRate(options, audioEntry.sampleRate)
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
            when (audioEntry) {
              is OfflineEntry.FileBacked -> nativeAlignAccurateFromFile(
                modelPath,
                text,
                audioEntry.filePath,
                normalizedGranularity,
              )

              is OfflineEntry.InMemory -> {
                if (audioEntry.samples.isEmpty()) {
                  promise.reject(
                    ERR_AUDIO_EMPTY,
                    "Offline audio buffer is empty: $audioInBufferId",
                  )
                  return@execute
                }
                nativeAlignAccurateFromFloatPcm(
                  modelPath,
                  text,
                  audioEntry.samples,
                  audioEntry.sampleRate,
                  normalizedGranularity,
                )
              }
            }
          }

          else -> throw IllegalArgumentException("Unsupported alignment mode: $normalizedMode")
        }

        promise.resolve(alignmentResultToWritable(raw))
      } catch (e: Exception) {
        Log.e(TAG, "ALIGNMENT_ERROR: ${e.message}", e)
        rejectWithEmbeddedCode(promise, ERR_ALIGNMENT, e.message ?: "Alignment failed", e)
      }
    }
  }

  fun alignTextToPcmForStt(
    text: String,
    samples: FloatArray,
    sampleRate: Int,
    mode: String,
    granularity: String,
    alignmentModelPath: String?,
    onSuccess: (segments: List<SttAlignmentSegment>, timingMode: String) -> Unit,
    onError: (message: String, error: Throwable?) -> Unit,
  ) {
    executor.execute {
      try {
        if (text.isBlank()) {
          onError("text is required", null)
          return@execute
        }
        if (sampleRate <= 0) {
          onError("sampleRate must be positive", null)
          return@execute
        }
        if (samples.isEmpty()) {
          onError("samples array is empty", null)
          return@execute
        }

        val normalizedMode = normalizeMode(mode)
        val normalizedGranularity = normalizeGranularity(granularity)

        val raw = when (normalizedMode) {
          "proportional" -> nativeAlignProportional(
            text,
            samples.size,
            sampleRate,
            normalizedGranularity,
          )

          "accurate" -> {
            val modelPath = alignmentModelPath?.trim().orEmpty()
            if (modelPath.isEmpty()) {
              throw IllegalArgumentException("ALIGNMENT_MODEL_MISSING: alignmentModelPath is required for accurate mode")
            }
            nativeAlignAccurateFromFloatPcm(
              modelPath,
              text,
              samples,
              sampleRate,
              normalizedGranularity,
            )
          }

          else -> throw IllegalArgumentException("Unsupported alignment mode for STT stage: $normalizedMode")
        }

        @Suppress("UNCHECKED_CAST")
        val subtitles = raw["subtitles"] as? ArrayList<HashMap<String, Any>>
          ?: throw IllegalStateException("native alignment: missing subtitles")
        val timingMode = raw["timingMode"] as? String
          ?: throw IllegalStateException("native alignment: missing timingMode")

        val segments = subtitles.map { item ->
          SttAlignmentSegment(
            text = item["text"] as? String ?: "",
            startSec = (item["start"] as? Double) ?: 0.0,
            endSec = (item["end"] as? Double) ?: 0.0,
          )
        }

        onSuccess(segments, timingMode)
      } catch (e: Exception) {
        Log.e(TAG, "ALIGNMENT_ERROR: ${e.message}", e)
        onError(e.message ?: "Alignment failed", e)
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

  private fun rejectWithEmbeddedCode(
    promise: Promise,
    fallbackCode: String,
    rawMessage: String,
    error: Throwable? = null,
  ) {
    val message = rawMessage.trim()
    val embeddedCode = message.substringBefore(':').trim()
    val code = if (embeddedCode.startsWith("ALIGNMENT_")) {
      embeddedCode
    } else {
      fallbackCode
    }
    promise.reject(code, message, error)
  }
}
