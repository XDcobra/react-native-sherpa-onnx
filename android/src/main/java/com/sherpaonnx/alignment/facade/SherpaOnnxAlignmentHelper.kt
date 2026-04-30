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

  private data class VadaAnchor(
    val startSample: Int,
    val endSample: Int,
  )

  private fun splitTextUnits(text: String, granularity: String): List<String> {
    if (granularity == "word") {
      return text.trim().split(Regex("\\s+")).filter { it.isNotBlank() }
    }
    return text
      .split(Regex("(?<=[.!?])\\s+"))
      .map { it.trim() }
      .filter { it.isNotBlank() }
  }

  private fun unitWeight(unit: String): Double {
    val compact = unit.filterNot { it.isWhitespace() }
    return compact.length.coerceAtLeast(1).toDouble()
  }

  private fun mapUnitsToAnchorsMonotonicWeight(
    units: List<String>,
    anchors: List<VadaAnchor>,
  ): List<List<String>> {
    val out = MutableList(anchors.size) { mutableListOf<String>() }
    if (units.isEmpty() || anchors.isEmpty()) return out
    val anchorDurations = anchors.map { (it.endSample - it.startSample).coerceAtLeast(1).toDouble() }
    val totalAnchor = anchorDurations.sum().coerceAtLeast(1.0)
    val anchorCum = DoubleArray(anchorDurations.size)
    var accA = 0.0
    for (i in anchorDurations.indices) {
      accA += anchorDurations[i]
      anchorCum[i] = accA / totalAnchor
    }
    val unitWeights = units.map(::unitWeight)
    val totalUnits = unitWeights.sum().coerceAtLeast(1.0)
    var accU = 0.0
    for (i in units.indices) {
      val w = unitWeights[i]
      val mid = (accU + (w / 2.0)) / totalUnits
      var anchorIdx = 0
      while (anchorIdx < anchorCum.lastIndex && anchorCum[anchorIdx] < mid) {
        anchorIdx += 1
      }
      out[anchorIdx].add(units[i])
      accU += w
    }
    return out
  }

  private fun resolveVadAnchorsFromOfflineBuffer(segmentationBufferId: String): List<VadaAnchor> {
    val anchorEntry = SegmentPipelineRegistry.getOffline(segmentationBufferId)
      ?: throw SegmentPipelineException(
        SegmentErrorCodes.BUFFER_NOT_FOUND,
        "Offline segment buffer not found: $segmentationBufferId"
      )
    return anchorEntry
      .snapshotSegments(0, Int.MAX_VALUE)
      .filter { it.kind == "speech" && it.endSample >= it.startSample }
      .map { VadaAnchor(it.startSample, it.endSample) }
  }

  private fun writeAlignmentResult(
    promise: Promise,
    segmentOutId: String,
    outputEntry: com.sherpaonnx.segment.pipeline.OfflineSegmentEntry,
    records: List<SegmentRecord>,
    warningCode: String? = null,
    vadAnchorCount: Int? = null,
    minAnchorsApplied: Int? = null,
  ) {
    outputEntry.populate(records)
    promise.resolve(
      com.facebook.react.bridge.Arguments.createMap().apply {
        putString("outputSegmentBufferId", segmentOutId)
        putInt("segmentsWritten", records.size)
        warningCode?.let { putString("warningCode", it) }
        vadAnchorCount?.let { putInt("vadAnchorCount", it) }
        minAnchorsApplied?.let { putInt("minAnchorsApplied", it) }
      }
    )
  }

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
        if (normalizedMode == "vad" && normalizedGranularity == "character") {
          promise.reject(
            SegmentErrorCodes.INVALID_ARGUMENT,
            "mode=vad supports only sentence or word granularity"
          )
          return@execute
        }
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
            val segmentationSource = AlignmentOptionParsers.parseSegmentationSource(options)
            if (segmentationSource == "vad") {
              if (normalizedGranularity == "character") {
                promise.reject(
                  SegmentErrorCodes.INVALID_ARGUMENT,
                  "accurate+vad supports only sentence or word granularity"
                )
                return@execute
              }
              val segmentationBufferId = AlignmentOptionParsers.parseSegmentationBufferId(options)
              if (!segmentationBufferId.startsWith("seg_off_")) {
                promise.reject(
                  SegmentErrorCodes.BUFFER_KIND_MISMATCH,
                  "Expected offline segment buffer (seg_off_*), got: $segmentationBufferId"
                )
                return@execute
              }
              val anchors = resolveVadAnchorsFromOfflineBuffer(segmentationBufferId)
              val minAnchors = AlignmentOptionParsers.parseMinAnchors(options)
              if (anchors.size < minAnchors) {
                val warningCode = if (anchors.isEmpty()) {
                  "ALIGNMENT_EMPTY_VAD_ANCHORS"
                } else {
                  "ALIGNMENT_BELOW_MIN_VAD_ANCHORS"
                }
                writeAlignmentResult(
                  promise,
                  segmentOutId,
                  outputEntry,
                  emptyList(),
                  warningCode = warningCode,
                  vadAnchorCount = anchors.size,
                  minAnchorsApplied = minAnchors,
                )
                return@execute
              }
              val allSamples = audioEntry.readAllSamples()
              if (allSamples.isEmpty()) {
                promise.reject(
                  AlignmentErrorCodes.ERR_AUDIO_EMPTY,
                  "Offline audio buffer is empty: $audioInBufferId",
                )
                return@execute
              }
              val units = splitTextUnits(text, normalizedGranularity)
              val mapped = mapUnitsToAnchorsMonotonicWeight(units, anchors)
              val unmappedAnchorCount = mapped.count { it.isEmpty() }
              val records = mutableListOf<SegmentRecord>()
              for (i in anchors.indices) {
                val unitGroup = mapped[i]
                if (unitGroup.isEmpty()) continue
                val joined = unitGroup.joinToString(" ").trim()
                if (joined.isEmpty()) continue
                val anchor = anchors[i]
                val start = anchor.startSample.coerceAtLeast(0).coerceAtMost(allSamples.size)
                val end = anchor.endSample.coerceAtLeast(start).coerceAtMost(allSamples.size)
                if (end <= start) continue
                val slice = allSamples.copyOfRange(start, end)
                val chunkRaw = try {
                  nativeAlignAccurateFromFloatPcm(
                    modelPath,
                    joined,
                    slice,
                    audioEntry.sampleRate,
                    normalizedGranularity,
                  )
                } catch (e: Exception) {
                  throw IllegalStateException(
                    "${AlignmentErrorCodes.ERR_CONSTRAINED_ACCURATE}: constrained accurate run failed for anchor $i: ${e.message}",
                    e,
                  )
                }
                val (subtitleItems) = AlignmentResultMapper.parseSubtitleItems(chunkRaw)
                val textUnitCountForGroup = splitTextUnits(joined, normalizedGranularity).size
                subtitleItems.forEachIndexed { itemIndex, item ->
                  val localStart = (item.startSec * audioEntry.sampleRate.toDouble())
                    .roundToInt()
                    .coerceAtLeast(0)
                  val localEnd = (item.endSec * audioEntry.sampleRate.toDouble())
                    .roundToInt()
                    .coerceAtLeast(localStart)
                  val startSample = (start + localStart).coerceAtMost(end)
                  val endSample = (start + localEnd).coerceAtLeast(startSample).coerceAtMost(end)
                  val durationMs =
                    (((endSample - startSample).coerceAtLeast(0) * 1000L) / audioEntry.sampleRate.toLong()).toInt()
                  val tokenMetadata = JSONObject().apply {
                    put("constraintSource", "vad")
                    put("constraintMode", "hard")
                    put("mappingStrategy", "vadMonotonicWeightDP")
                    put("textUnitCount", units.size)
                    put("vadAnchorCount", anchors.size)
                    put("mappedUnitCount", textUnitCountForGroup)
                    put("unmappedVadAnchorCount", unmappedAnchorCount)
                    put("minAnchorsApplied", minAnchors)
                  }
                  records.add(
                    SegmentRecord(
                      id = "seg_align_acc_vad_${i}_${itemIndex}_${startSample}_$endSample",
                      kind = "alignment",
                      sourceAudioBufferId = audioId,
                      startSample = startSample,
                      endSample = endSample,
                      sampleRate = audioEntry.sampleRate,
                      durationMs = durationMs,
                      payloadJson = JSONObject().apply {
                        put("text", item.text)
                        put("timingMode", "accurate")
                        put("granularity", normalizedGranularity)
                        put("tokenMetadata", tokenMetadata)
                      }.toString(),
                    )
                  )
                }
              }
              writeAlignmentResult(promise, segmentOutId, outputEntry, records)
              return@execute
            }
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

          "vad" -> {
            val segmentationBufferId = AlignmentOptionParsers.parseSegmentationBufferId(options)
            if (!segmentationBufferId.startsWith("seg_off_")) {
              promise.reject(
                SegmentErrorCodes.BUFFER_KIND_MISMATCH,
                "Expected offline segment buffer (seg_off_*), got: $segmentationBufferId"
              )
              return@execute
            }
            val anchors = resolveVadAnchorsFromOfflineBuffer(segmentationBufferId)
            if (anchors.isEmpty()) {
              writeAlignmentResult(promise, segmentOutId, outputEntry, emptyList())
              return@execute
            }
            val units = splitTextUnits(text, normalizedGranularity)
            val mapped = mapUnitsToAnchorsMonotonicWeight(units, anchors)
            val records = mutableListOf<SegmentRecord>()
            for (i in anchors.indices) {
              val unitGroup = mapped[i]
              if (unitGroup.isEmpty()) continue
              val joined = if (normalizedGranularity == "word") {
                unitGroup.joinToString(" ")
              } else {
                unitGroup.joinToString(" ")
              }.trim()
              if (joined.isEmpty()) continue
              val anchor = anchors[i]
              val durationMs =
                (((anchor.endSample - anchor.startSample).coerceAtLeast(0) * 1000L) / audioEntry.sampleRate.toLong()).toInt()
              val tokenMetadata = JSONObject().apply {
                put("mappingStrategy", "vadMonotonicWeightDP")
                put("textUnitCount", units.size)
                put("vadAnchorCount", anchors.size)
                put("mappedUnitCount", unitGroup.size)
                put("unmappedVadAnchorCount", mapped.count { it.isEmpty() })
              }
              records.add(
                SegmentRecord(
                  id = "seg_align_vad_${i}_${anchor.startSample}_${anchor.endSample}",
                  kind = "alignment",
                  sourceAudioBufferId = audioId,
                  startSample = anchor.startSample,
                  endSample = anchor.endSample,
                  sampleRate = audioEntry.sampleRate,
                  durationMs = durationMs,
                  payloadJson = JSONObject().apply {
                    put("text", joined)
                    put("timingMode", "vad")
                    put("granularity", normalizedGranularity)
                    put("tokenMetadata", tokenMetadata)
                  }.toString(),
                )
              )
            }
            writeAlignmentResult(promise, segmentOutId, outputEntry, records)
            return@execute
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
    modelPath: String?,
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
            val resolved = modelPath?.trim().orEmpty()
            if (resolved.isEmpty()) {
              throw IllegalArgumentException("ALIGNMENT_MODEL_MISSING: modelPath is required for accurate mode")
            }
            nativeAlignAccurateFromFloatPcm(
              resolved,
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
