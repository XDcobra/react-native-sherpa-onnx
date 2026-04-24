package com.sherpaonnx.alignment.facade

import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.sherpaonnx.alignment.core.AlignmentErrorCodes
import com.sherpaonnx.alignment.core.AlignmentOptionParsers
import com.sherpaonnx.alignment.core.AlignmentPromiseUtils
import com.sherpaonnx.alignment.core.AlignmentResultMapper
import com.sherpaonnx.alignment.core.SttAlignmentSegment
import com.sherpaonnx.audio.pipeline.OfflineEntry
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.errors.OfflineOomError
import com.sherpaonnx.segment.pipeline.SegmentErrorCodes
import com.sherpaonnx.segment.pipeline.SegmentPipelineException
import com.sherpaonnx.segment.pipeline.SegmentPipelineRegistry
import com.sherpaonnx.segment.pipeline.SegmentRecord
import com.sherpaonnx.text.pipeline.TextPipelineRegistry
import org.json.JSONObject
import java.util.HashMap
import java.util.concurrent.Executors
import kotlin.math.roundToInt

internal class SherpaOnnxAlignmentHelper {
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
    segmentOutBufferId: String,
    mode: String,
    granularity: String,
    options: ReadableMap?,
    promise: Promise,
  ) {
    executor.execute {
      try {
        val textId = textInBufferId.trim()
        if (textId.isEmpty()) {
          promise.reject(AlignmentErrorCodes.ERR_TEXT_NOT_FOUND, "textInBufferId is required")
          return@execute
        }
        if (!textId.startsWith("txt_off_")) {
          promise.reject(
            AlignmentErrorCodes.ERR_TEXT_KIND_MISMATCH,
            "Expected offline text buffer (txt_off_*), got: $textInBufferId",
          )
          return@execute
        }

        val textEntry = TextPipelineRegistry.getOffline(textId)
        if (textEntry == null) {
          if (TextPipelineRegistry.getLive(textId) != null) {
            promise.reject(
              AlignmentErrorCodes.ERR_TEXT_KIND_MISMATCH,
              "Expected offline text buffer (txt_off_*), got live buffer: $textInBufferId",
            )
          } else {
            promise.reject(
              AlignmentErrorCodes.ERR_TEXT_NOT_FOUND,
              "Offline text buffer not found: $textId",
            )
          }
          return@execute
        }

        val text = textEntry.text
        if (!textEntry.populated || text.isBlank()) {
          promise.reject(
            AlignmentErrorCodes.ERR_TEXT_EMPTY,
            "Offline text buffer is empty or not populated: $textInBufferId",
          )
          return@execute
        }

        val audioId = audioInBufferId.trim()
        if (audioId.isEmpty()) {
          promise.reject(AlignmentErrorCodes.ERR_AUDIO_NOT_FOUND, "audioInBufferId is required")
          return@execute
        }
        if (!audioId.startsWith("off_")) {
          promise.reject(
            AlignmentErrorCodes.ERR_AUDIO_KIND_MISMATCH,
            "Expected offline audio buffer (off_*), got: $audioInBufferId",
          )
          return@execute
        }

        val audioEntry = PipelineAudioRegistry.getOffline(audioId)
        if (audioEntry == null) {
          if (PipelineAudioRegistry.getLive(audioId) != null) {
            promise.reject(
              AlignmentErrorCodes.ERR_AUDIO_KIND_MISMATCH,
              "Expected offline audio buffer (off_*), got live buffer: $audioInBufferId",
            )
          } else {
            promise.reject(
              AlignmentErrorCodes.ERR_AUDIO_NOT_FOUND,
              "Offline audio buffer not found: $audioId",
            )
          }
          return@execute
        }

        if (audioEntry.sampleRate <= 0 || audioEntry.numSamples <= 0) {
          promise.reject(
            AlignmentErrorCodes.ERR_AUDIO_EMPTY,
            "Offline audio buffer is empty: $audioInBufferId",
          )
          return@execute
        }

        val segmentOutId = segmentOutBufferId.trim()
        if (segmentOutId.isEmpty()) {
          promise.reject(
            SegmentErrorCodes.INVALID_ARGUMENT,
            "segmentOutBufferId is required"
          )
          return@execute
        }
        if (!segmentOutId.startsWith("seg_off_")) {
          promise.reject(
            SegmentErrorCodes.BUFFER_KIND_MISMATCH,
            "Expected offline segment buffer (seg_off_*), got: $segmentOutBufferId"
          )
          return@execute
        }
        val outputEntry = SegmentPipelineRegistry.getOffline(segmentOutId)
        if (outputEntry == null) {
          promise.reject(
            SegmentErrorCodes.BUFFER_NOT_FOUND,
            "Offline segment buffer not found: $segmentOutBufferId"
          )
          return@execute
        }

        val normalizedMode = AlignmentOptionParsers.normalizeMode(mode)
        val normalizedGranularity = AlignmentOptionParsers.normalizeGranularity(granularity)

        val raw = when (normalizedMode) {
          "proportional" -> nativeAlignProportional(
            text,
            audioEntry.numSamples,
            audioEntry.sampleRate,
            normalizedGranularity,
          )

          "estimated" -> {
            val estimatedRate = AlignmentOptionParsers.parseEstimatedSampleRate(options, audioEntry.sampleRate)
            val counts = AlignmentOptionParsers.parseSegmentSampleCounts(options)
            nativeAlignEstimated(
              text,
              counts,
              estimatedRate,
              normalizedGranularity,
            )
          }

          "accurate" -> {
            val modelPath = AlignmentOptionParsers.parseAlignmentModelPath(options)
            val samples = audioEntry.readAllSamples()
            if (samples.isEmpty()) {
              promise.reject(
                AlignmentErrorCodes.ERR_AUDIO_EMPTY,
                "Offline audio buffer is empty: $audioInBufferId",
              )
              return@execute
            }
            nativeAlignAccurateFromFloatPcm(
              modelPath,
              text,
              samples,
              audioEntry.sampleRate,
              normalizedGranularity,
            )
          }

          else -> throw IllegalArgumentException("Unsupported alignment mode: $normalizedMode")
        }
        val (subtitleItems, timingModeRaw) = AlignmentResultMapper.parseSubtitleItems(raw)
        val timingMode = when (timingModeRaw.trim().lowercase()) {
          "aligned" -> "accurate"
          "proportional", "estimated", "accurate", "vad" -> timingModeRaw.trim().lowercase()
          else -> normalizedMode
        }
        val records = subtitleItems.mapIndexed { index, item ->
          val startSample = (item.startSec * audioEntry.sampleRate.toDouble())
            .roundToInt()
            .coerceAtLeast(0)
          val endSample = (item.endSec * audioEntry.sampleRate.toDouble())
            .roundToInt()
            .coerceAtLeast(startSample)
          val durationMs =
            (((endSample - startSample).coerceAtLeast(0) * 1000L) / audioEntry.sampleRate.toLong()).toInt()
          SegmentRecord(
            id = "seg_align_${index}_${startSample}_$endSample",
            kind = "alignment",
            sourceAudioBufferId = audioId,
            startSample = startSample,
            endSample = endSample,
            sampleRate = audioEntry.sampleRate,
            durationMs = durationMs,
            payloadJson = JSONObject().apply {
              put("text", item.text)
              put("timingMode", timingMode)
              put("granularity", normalizedGranularity)
            }.toString(),
          )
        }
        outputEntry.populate(records)
        promise.resolve(
          com.facebook.react.bridge.Arguments.createMap().apply {
            putString("outputSegmentBufferId", segmentOutId)
            putInt("segmentsWritten", records.size)
          }
        )
      } catch (e: SegmentPipelineException) {
        promise.reject(e.code, e.message, e)
      } catch (e: OutOfMemoryError) {
        Log.e(AlignmentErrorCodes.TAG, "OFFLINE_OOM: ${e.message}", e)
        promise.reject(
          AlignmentErrorCodes.OFFLINE_OOM,
          OfflineOomError.message("alignment"),
          e
        )
      } catch (e: Exception) {
        Log.e(AlignmentErrorCodes.TAG, "ALIGNMENT_ERROR: ${e.message}", e)
        AlignmentPromiseUtils.rejectWithEmbeddedCode(
          promise,
          AlignmentErrorCodes.ERR_ALIGNMENT,
          e.message ?: "Alignment failed",
          e,
        )
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

        val normalizedMode = AlignmentOptionParsers.normalizeMode(mode)
        val normalizedGranularity = AlignmentOptionParsers.normalizeGranularity(granularity)

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

        val (segments, timingMode) = AlignmentResultMapper.parseSttSegments(raw)
        onSuccess(segments, timingMode)
      } catch (e: Exception) {
        Log.e(AlignmentErrorCodes.TAG, "ALIGNMENT_ERROR: ${e.message}", e)
        onError(e.message ?: "Alignment failed", e)
      }
    }
  }
}
