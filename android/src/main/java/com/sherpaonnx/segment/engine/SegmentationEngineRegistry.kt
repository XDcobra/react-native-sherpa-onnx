package com.sherpaonnx.segment.engine

import java.util.concurrent.ConcurrentHashMap
import org.json.JSONArray
import org.json.JSONObject

enum class EngineState {
  ACTIVE,
  DETACHED,
  RELEASED,
}

enum class EngineDomain {
  TEXT,
  SPEECH,
}

data class SegmentationEnginePolicy(
  val evaluator: String,
  val maxLengthChars: Int = 2000,
  val sentenceBoundary: Boolean = true,
  /** When non-null and non-empty, replaces the built-in delimiter set entirely. */
  val sentenceBoundaryChars: List<String>? = null,
  val silenceThresholdMs: Int = 500,
  val energyThresholdDb: Double = -40.0,
  val minSegmentMs: Int = 1000,
  val maxSegmentMs: Int = 120000,
  val hangoverMs: Int = 300,
  val checkpointIntervalMs: Int = 0,
  val punctuationInstanceId: String? = null,
  /** Absolute path to the VAD `.onnx` file (from JS `detectVadModel`). */
  val modelPath: String? = null,
  /** `silero_vad` or `ten_vad` (from JS `detectVadModel`). */
  val modelType: String? = null,
  val vadThreshold: Double? = null,
  val vadMinSpeechMs: Int? = null,
  val vadMinSilenceMs: Int? = null,
  /** Pyannote window shift ratio (speech_pyannote_segmentation). */
  val windowShiftRatio: Double = 0.1,
  /** Pyannote min speech duration in seconds. */
  val minDurationOn: Double = 0.3,
  /** Pyannote max gap merge in seconds. */
  val minDurationOff: Double = 0.5,
)

data class SegmentationEngineInfoSnapshot(
  val engineId: String,
  val attachedBufferId: String,
  val domain: EngineDomain,
  val policy: SegmentationEnginePolicy,
  val state: EngineState,
  val totalSegmentsCommitted: Int,
  val lastSegmentId: String?,
  val segmentBufferId: String?,
)

data class SegmentAnnotationSnapshot(
  val reason: String,
  val source: String,
  val createdAtMs: Long,
  val segmentIndex: Int,
)

private class SegmentationEngineException(
  val code: String,
  override val message: String,
) : RuntimeException(message)

object SegmentationEngineRegistry {
  private val segmentAnnotationBySegmentId =
    ConcurrentHashMap<String, SegmentAnnotationSnapshot>()

  private fun policyJson(rawPolicy: Map<String, Any?>): String {
    return try {
      JSONObject(rawPolicy).toString()
    } catch (error: Exception) {
      throw SegmentationEngineException(
        code = "POLICY_INVALID",
        message = error.message ?: "Invalid segmentation policy",
      )
    }
  }

  private fun requireOk(json: String?): JSONObject {
    if (json.isNullOrEmpty()) {
      throw SegmentationEngineException(
        code = "SEGMENT_INTERNAL_ERROR",
        message = "Segmentation engine native call failed",
      )
    }
    val root = JSONObject(json)
    if (!root.optBoolean("ok", false)) {
      throw SegmentationEngineException(
        code = root.optString("code", "SEGMENT_INTERNAL_ERROR"),
        message = root.optString("message", "Segmentation engine error"),
      )
    }
    return root
  }

  private fun emptyToNull(value: String): String? = value.ifEmpty { null }

  private fun policyFromJson(policy: JSONObject): SegmentationEnginePolicy {
    val chars =
      if (policy.has("sentenceBoundaryChars")) {
        val arr = policy.optJSONArray("sentenceBoundaryChars")
        if (arr == null) {
          null
        } else {
          val out = ArrayList<String>(arr.length())
          for (i in 0 until arr.length()) {
            val s = arr.optString(i)
            if (s.isNotEmpty()) out.add(s)
          }
          out.ifEmpty { null }
        }
      } else {
        null
      }
    val modelPath = emptyToNull(policy.optString("modelPath", ""))
    return SegmentationEnginePolicy(
      evaluator = policy.optString("evaluator", "text_synthetic_auto"),
      maxLengthChars = policy.optInt("maxLengthChars", 2000),
      sentenceBoundary = policy.optBoolean("sentenceBoundary", true),
      sentenceBoundaryChars = chars,
      silenceThresholdMs = policy.optInt("silenceThresholdMs", 500),
      energyThresholdDb = policy.optDouble("energyThresholdDb", -40.0),
      minSegmentMs = policy.optInt("minSegmentMs", 1000),
      maxSegmentMs = policy.optInt("maxSegmentMs", 120000),
      hangoverMs = policy.optInt("hangoverMs", 300),
      checkpointIntervalMs = policy.optInt("checkpointIntervalMs", 0),
      punctuationInstanceId = emptyToNull(policy.optString("punctuationInstanceId", "")),
      modelPath = modelPath,
      modelType = emptyToNull(policy.optString("modelType", "")),
      vadThreshold = if (policy.has("vadThreshold")) policy.optDouble("vadThreshold") else null,
      vadMinSpeechMs = if (policy.has("vadMinSpeechMs")) policy.optInt("vadMinSpeechMs") else null,
      vadMinSilenceMs = if (policy.has("vadMinSilenceMs")) policy.optInt("vadMinSilenceMs") else null,
      windowShiftRatio = policy.optDouble("windowShiftRatio", 0.1),
      minDurationOn = policy.optDouble("minDurationOn", 0.3),
      minDurationOff = policy.optDouble("minDurationOff", 0.5),
    )
  }

  private fun infoFromJson(info: JSONObject): SegmentationEngineInfoSnapshot {
    val domain =
      if (info.optString("domain") == "speech") EngineDomain.SPEECH else EngineDomain.TEXT
    val state =
      when (info.optString("state")) {
        "released" -> EngineState.RELEASED
        "detached" -> EngineState.DETACHED
        else -> EngineState.ACTIVE
      }
    return SegmentationEngineInfoSnapshot(
      engineId = info.optString("engineId"),
      attachedBufferId = info.optString("attachedBufferId"),
      domain = domain,
      policy = policyFromJson(info.optJSONObject("policy") ?: JSONObject()),
      state = state,
      totalSegmentsCommitted = info.optInt("totalSegmentsCommitted", 0),
      lastSegmentId = emptyToNull(info.optString("lastSegmentId", "")),
      segmentBufferId = emptyToNull(info.optString("segmentBufferId", "")),
    )
  }

  fun attachEngine(
    bufferId: String,
    domainRaw: String,
    rawPolicy: Map<String, Any?>,
  ): SegmentationEngineInfoSnapshot {
    val root =
      requireOk(
        SegmentationEngineNative.nativeAttach(bufferId, domainRaw, policyJson(rawPolicy)),
      )
    return infoFromJson(root.getJSONObject("info"))
  }

  fun detachEngine(engineId: String, flushFinal: Boolean) {
    requireOk(SegmentationEngineNative.nativeDetach(engineId, flushFinal))
  }

  fun flushEngine(engineId: String) {
    requireOk(SegmentationEngineNative.nativeFlush(engineId))
  }

  fun getEngineInfo(engineId: String): SegmentationEngineInfoSnapshot {
    val root = requireOk(SegmentationEngineNative.nativeGetInfo(engineId))
    return infoFromJson(root.getJSONObject("info"))
  }

  fun releaseAll() {
    SegmentationEngineNative.nativeReleaseAll()
    segmentAnnotationBySegmentId.clear()
  }

  fun recordSegmentAnnotation(
    segmentId: String,
    annotation: SegmentAnnotationSnapshot,
  ) {
    SegmentationEngineNative.nativeRecordAnnotation(
      segmentId,
      annotation.reason,
      annotation.source,
      annotation.createdAtMs,
      annotation.segmentIndex,
    )
    // Keep a thin mirror for consumeSegmentAnnotation callers.
    segmentAnnotationBySegmentId[segmentId] = annotation
  }

  fun consumeSegmentAnnotation(segmentId: String): SegmentAnnotationSnapshot? {
    return segmentAnnotationBySegmentId.remove(segmentId) ?: peekSegmentAnnotation(segmentId)
  }

  fun peekSegmentAnnotation(segmentId: String): SegmentAnnotationSnapshot? {
    val json = SegmentationEngineNative.nativePeekAnnotation(segmentId)
    if (json.isNotEmpty()) {
      val root = JSONObject(json)
      if (root.optBoolean("found", false)) {
        return SegmentAnnotationSnapshot(
          reason = root.optString("reason", "manual_commit"),
          source = root.optString("source", "segmentation_engine"),
          createdAtMs = root.optLong("createdAtMs", 0L),
          segmentIndex = root.optInt("segmentIndex", 0),
        )
      }
    }
    return segmentAnnotationBySegmentId[segmentId]
  }

  fun segmentOfflineBuffer(
    bufferId: String,
    domainRaw: String,
    rawPolicy: Map<String, Any?>,
  ): Map<String, Any?> {
    val root =
      requireOk(
        SegmentationEngineNative.nativeSegmentOffline(bufferId, domainRaw, policyJson(rawPolicy)),
      )
    val out = LinkedHashMap<String, Any?>()
    out["bufferId"] = root.optString("bufferId", bufferId)
    out["kind"] = root.optString("kind", "offlineSegmentBuffer")
    out["state"] = root.optString("state", "immutable")
    out["segmentCount"] = root.optInt("segmentCount", 0)
    if (root.has("sourceAudioBufferId")) {
      out["sourceAudioBufferId"] = root.optString("sourceAudioBufferId")
    }
    val segments = root.optJSONArray("segments")
    if (segments != null) {
      out["segments"] = textSegmentsFromJson(segments)
    }
    return out
  }

  private fun textSegmentsFromJson(segments: JSONArray): List<Map<String, Any?>> {
    val records = ArrayList<Map<String, Any?>>(segments.length())
    for (i in 0 until segments.length()) {
      val segment = segments.optJSONObject(i) ?: continue
      records.add(
        mapOf(
          "segmentId" to segment.optString("segmentId"),
          "startOffset" to segment.optInt("startOffset"),
          "endOffset" to segment.optInt("endOffset"),
          "reason" to segment.optString("reason", "manual_commit"),
          "source" to segment.optString("source", "manual"),
          "text" to segment.optString("text"),
        ),
      )
    }
    return records
  }

  fun toError(
    throwable: Throwable,
    fallbackCode: String,
  ): Pair<String, String> {
    return if (throwable is SegmentationEngineException) {
      Pair(throwable.code, throwable.message)
    } else {
      Pair(fallbackCode, throwable.message ?: "Unknown segmentation engine error")
    }
  }
}
