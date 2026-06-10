package com.sherpaonnx.segment.engine

import com.sherpaonnx.audio.pipeline.LiveEntry
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.punctuation.core.PunctuationTextInputNormalization
import com.sherpaonnx.punctuation.facade.SherpaOnnxOnlinePunctuationHelper
import com.sherpaonnx.punctuation.facade.SherpaOnnxPunctuationHelper
import com.sherpaonnx.segment.pipeline.OfflineSegmentEntry
import com.sherpaonnx.segment.pipeline.SegmentPipelineRegistry
import com.sherpaonnx.segment.pipeline.SegmentRecord
import com.sherpaonnx.text.pipeline.TextPipelineRegistry
import com.sherpaonnx.text.pipeline.LiveTextEntry
import com.sherpaonnx.vad.core.VadRuntime
import com.sherpaonnx.vad.core.VadRuntimeOptions
import com.sherpaonnx.vad.core.createVadRuntime
import com.sherpaonnx.vad.core.defaultRuntimeOptions
import com.sherpaonnx.vad.core.withRuntimeOverrides
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.log10
import kotlin.math.sqrt
import org.json.JSONObject

private const val MAX_SENTENCE_BOUNDARY_DELIMITER_ENTRIES = 128
private const val MAX_SENTENCE_BOUNDARY_DELIMITER_STRLEN = 64

/**
 * Default sentence / clause boundaries for offline + live text segmentation: Latin, newline,
 * full-width CJK punctuation, Arabic question mark, Devanagari danda — aligned with iOS
 * `seg_text_sentence_boundary_charset`. Replaced entirely when `policy.sentenceBoundaryChars` is set.
 */
private val DEFAULT_SENTENCE_BOUNDARY_DELIMITERS: List<String> =
  listOf(
    ".",
    "!",
    "?",
    ";",
    ":",
    "\n",
    "\u3002",
    "\uFF01",
    "\uFF1F",
    "\uFF61",
    "\u061F",
    "\u0964",
    "\u0965",
  )

private fun resolveSentenceBoundaryDelimiters(
  policy: SegmentationEnginePolicy,
): List<String> {
  val custom = policy.sentenceBoundaryChars
  return if (!custom.isNullOrEmpty()) custom else DEFAULT_SENTENCE_BOUNDARY_DELIMITERS
}

/** Earliest end-exclusive index where `text[0..i)` ends with a delimiter (offline forward scan). */
private fun firstDelimiterEndExclusive(text: String, delimiters: List<String>): Int {
  if (text.isEmpty()) return -1
  for (i in 1..text.length) {
    val slice = text.substring(0, i)
    for (d in delimiters) {
      if (d.isNotEmpty() && slice.endsWith(d)) {
        return i
      }
    }
  }
  return -1
}

/** Latest end-exclusive index where `text[0..i)` ends with a delimiter (live: commit at last boundary). */
private fun lastDelimiterEndExclusive(text: String, delimiters: List<String>): Int {
  for (i in text.length downTo 1) {
    val slice = text.substring(0, i)
    for (d in delimiters) {
      if (d.isNotEmpty() && slice.endsWith(d)) {
        return i
      }
    }
  }
  return -1
}

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
  /** When non-null and non-empty, replaces [DEFAULT_SENTENCE_BOUNDARY_DELIMITERS] entirely. */
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

private interface PaSegmentationEngine {
  val engineId: String
  val domain: EngineDomain
  val attachedBufferId: String
  val policy: SegmentationEnginePolicy
  val segmentBufferId: String?

  fun state(): EngineState
  fun evaluateText()
  fun evaluateAudioChunk(
    chunk: FloatArray,
    sampleRate: Int,
    totalSamplesWritten: Long,
  )

  fun flush()
  fun detach()
  fun release()
  fun info(): SegmentationEngineInfoSnapshot
}

private abstract class BaseSegmentationEngine(
  override val engineId: String,
  override val domain: EngineDomain,
  override val attachedBufferId: String,
  override val policy: SegmentationEnginePolicy,
) : PaSegmentationEngine {
  @Volatile
  protected var currentState: EngineState = EngineState.ACTIVE

  @Volatile
  protected var totalSegmentsCommitted: Int = 0

  @Volatile
  protected var lastSegmentId: String? = null

  protected fun nowMs(): Long = System.currentTimeMillis()

  override fun state(): EngineState = currentState

  override fun evaluateText() = Unit

  override fun evaluateAudioChunk(
    chunk: FloatArray,
    sampleRate: Int,
    totalSamplesWritten: Long,
  ) = Unit

  override fun detach() {
    if (currentState == EngineState.RELEASED) return
    currentState = EngineState.DETACHED
  }

  override fun release() {
    currentState = EngineState.RELEASED
  }

  override fun info(): SegmentationEngineInfoSnapshot {
    return SegmentationEngineInfoSnapshot(
      engineId = engineId,
      attachedBufferId = attachedBufferId,
      domain = domain,
      policy = policy,
      state = currentState,
      totalSegmentsCommitted = totalSegmentsCommitted,
      lastSegmentId = lastSegmentId,
      segmentBufferId = segmentBufferId,
    )
  }
}

private class TextSyntheticAutoEngine(
  engineId: String,
  attachedBufferId: String,
  policy: SegmentationEnginePolicy,
) : BaseSegmentationEngine(
  engineId = engineId,
  domain = EngineDomain.TEXT,
  attachedBufferId = attachedBufferId,
  policy = policy,
) {
  override val segmentBufferId: String? = null

  private val boundaryDelimiters: List<String> = resolveSentenceBoundaryDelimiters(policy)

  private fun commitIfNeeded(entry: LiveTextEntry, reason: String): Boolean {
    if (currentState != EngineState.ACTIVE) return false

    val partial = entry.currentText
    if (partial.isEmpty()) return false

    var commitLength = 0
    var commitReason = reason

    if (policy.sentenceBoundary) {
      val endExclusive = lastDelimiterEndExclusive(partial, boundaryDelimiters)
      if (endExclusive >= 0) {
        commitLength = endExclusive
        commitReason = "punctuation"
      }
    }

    if (commitLength <= 0 && partial.length >= policy.maxLengthChars) {
      val maxLen = policy.maxLengthChars.coerceAtLeast(1)
      val prefix = partial.substring(0, maxLen)
      val breakAt = prefix.lastIndexOf(' ').let { if (it <= 0) maxLen else it + 1 }
      commitLength = breakAt
      commitReason = "length_limit"
    }

    if (reason == "finalize") {
      commitLength = partial.length
      commitReason = "finalize"
    }

    if (commitLength <= 0) return false

    val committedText = partial.substring(0, commitLength)
    val remainder = partial.substring(commitLength)
    if (committedText.isBlank() && reason != "finalize") {
      entry.writePartial(remainder)
      return false
    }

    val createdAtMs = nowMs()
    val meta = mutableMapOf<String, Any?>(
      "__segmentReason" to commitReason,
      "__segmentSource" to "segmentation_engine",
      "__segmentCreatedAtMs" to createdAtMs,
    )

    val segmentIndex = entry.commitSegment(
      text = committedText,
      source = "stt_stream",
      meta = meta,
    )
    entry.writePartial(remainder)

    totalSegmentsCommitted += 1
    lastSegmentId = "txtseg_${attachedBufferId}_${segmentIndex}"
    return true
  }

  override fun evaluateText() {
    if (currentState != EngineState.ACTIVE) return
    val entry = TextPipelineRegistry.getLive(attachedBufferId) ?: return
    var madeProgress = true
    while (madeProgress) {
      madeProgress = commitIfNeeded(entry, "policy_checkpoint")
    }
  }

  override fun flush() {
    if (currentState != EngineState.ACTIVE) return
    val entry = TextPipelineRegistry.getLive(attachedBufferId) ?: return
    commitIfNeeded(entry, "finalize")
  }
}

private fun resolvePunctuatedTextOrThrow(instanceId: String, text: String): String {
  val online = SherpaOnnxOnlinePunctuationHelper.processOnlineIfExists(instanceId, text)
  if (online != null) return online
  val offline = SherpaOnnxPunctuationHelper.processOfflineIfExists(instanceId, text)
  if (offline != null) return offline
  throw SegmentationEngineException(
    code = "POLICY_PUNCTUATION_INSTANCE_NOT_FOUND",
    message = "text_punctuation_assisted requires a valid punctuationInstanceId; not found: $instanceId",
  )
}

/**
 * Maps the first sentence boundary in punctuated text back to a prefix length in the
 * (length-preserving) normalized partial. Punctuation can insert `.?!` so punctuated
 * indices must not be applied directly to the raw partial string.
 */
private fun assistedCommitLengthFromPunctuated(
  partial: String,
  punctuationInstanceId: String,
  delimiters: List<String>,
): Int {
  if (partial.isEmpty()) return 0
  val normalized =
    PunctuationTextInputNormalization.normalize(partial, null)
  val punctuated = resolvePunctuatedTextOrThrow(punctuationInstanceId, normalized)
  val endInPunctuated = firstDelimiterEndExclusive(punctuated, delimiters)
  if (endInPunctuated <= 0) return 0
  if (endInPunctuated <= normalized.length) {
    return minOf(partial.length, endInPunctuated)
  }
  var n = minOf(normalized.length, endInPunctuated)
  while (n > 0) {
    val prefixPunctuated =
      resolvePunctuatedTextOrThrow(
        punctuationInstanceId,
        normalized.substring(0, n),
      )
    if (firstDelimiterEndExclusive(prefixPunctuated, delimiters) == prefixPunctuated.length) {
      return minOf(partial.length, n)
    }
    n--
  }
  return 0
}

private class TextPunctuationAssistedEngine(
  engineId: String,
  attachedBufferId: String,
  policy: SegmentationEnginePolicy,
) : BaseSegmentationEngine(
  engineId = engineId,
  domain = EngineDomain.TEXT,
  attachedBufferId = attachedBufferId,
  policy = policy,
) {
  override val segmentBufferId: String? = null

  private val boundaryDelimiters: List<String> = resolveSentenceBoundaryDelimiters(policy)

  private fun commitIfNeeded(entry: LiveTextEntry, reason: String): Boolean {
    if (currentState != EngineState.ACTIVE) return false
    val partial = entry.currentText
    if (partial.isEmpty()) return false

    val instanceId = policy.punctuationInstanceId
      ?: throw SegmentationEngineException(
        code = "POLICY_PUNCTUATION_INSTANCE_NOT_FOUND",
        message = "text_punctuation_assisted requires policy.punctuationInstanceId",
      )

    var commitLength = 0
    var commitReason = reason
    if (policy.sentenceBoundary) {
      commitLength =
        assistedCommitLengthFromPunctuated(partial, instanceId, boundaryDelimiters)
      if (commitLength > 0) {
        commitReason = "punctuation"
      }
    }

    if (commitLength <= 0 && partial.length >= policy.maxLengthChars) {
      val maxLen = policy.maxLengthChars.coerceAtLeast(1)
      val prefix = partial.substring(0, maxLen)
      commitLength = prefix.lastIndexOf(' ').let { if (it <= 0) maxLen else it + 1 }
      commitReason = "length_limit"
    }

    if (reason == "finalize") {
      commitLength = partial.length
      commitReason = "finalize"
    }

    if (commitLength <= 0) return false
    val committedText = partial.substring(0, commitLength)
    val remainder = partial.substring(commitLength)
    if (committedText.isBlank() && reason != "finalize") {
      entry.writePartial(remainder)
      return false
    }

    val segmentIndex = entry.commitSegment(
      text = committedText,
      source = "stt_stream",
      meta = mutableMapOf<String, Any?>(
        "__segmentReason" to commitReason,
        "__segmentSource" to "segmentation_engine",
        "__segmentCreatedAtMs" to nowMs(),
        "punctuationInstanceId" to instanceId,
      ),
    )
    entry.writePartial(remainder)

    totalSegmentsCommitted += 1
    lastSegmentId = "txtseg_${attachedBufferId}_${segmentIndex}"
    return true
  }

  override fun evaluateText() {
    if (currentState != EngineState.ACTIVE) return
    val entry = TextPipelineRegistry.getLive(attachedBufferId) ?: return
    var madeProgress = true
    while (madeProgress) {
      madeProgress = commitIfNeeded(entry, "policy_checkpoint")
    }
  }

  override fun flush() {
    if (currentState != EngineState.ACTIVE) return
    val entry = TextPipelineRegistry.getLive(attachedBufferId) ?: return
    commitIfNeeded(entry, "finalize")
  }
}

private class SpeechEnergySilenceEngine(
  engineId: String,
  attachedBufferId: String,
  policy: SegmentationEnginePolicy,
  override val segmentBufferId: String,
) : BaseSegmentationEngine(
  engineId = engineId,
  domain = EngineDomain.SPEECH,
  attachedBufferId = attachedBufferId,
  policy = policy,
) {
  private var segmentStartSample: Long = 0L
  private var silenceAccumulatedMs: Double = 0.0
  private var checkpointStartSample: Long = 0L

  private fun appendSegment(
    endSampleExclusive: Long,
    reason: String,
    source: String,
    score: Double? = null,
  ) {
    if (endSampleExclusive <= segmentStartSample) return
    val segEntry = SegmentPipelineRegistry.getLive(segmentBufferId) ?: return
    val sampleRate = PipelineAudioRegistry.getLive(attachedBufferId)?.sampleRate ?: return
    val durationMs = (((endSampleExclusive - segmentStartSample) * 1000.0) / sampleRate).toInt()
    if (durationMs <= 0) return

    val payload = JSONObject()
      .put("source", "vad")
      .put("engine", "vad")
      .put("decision", "model")
    if (score != null && score.isFinite()) {
      payload.put("score", score)
    }

    val (segmentId, _) = segEntry.appendSegment(
      kind = "speech",
      sourceAudioBufferId = attachedBufferId,
      startSample = segmentStartSample.toInt(),
      endSample = endSampleExclusive.toInt(),
      sampleRate = sampleRate,
      durationMs = durationMs,
      confidence = null,
      payloadJson = payload.toString(),
      annotationReason = reason,
      annotationSource = source,
      annotationCreatedAtMs = nowMs(),
    )

    totalSegmentsCommitted += 1
    lastSegmentId = segmentId
    segmentStartSample = endSampleExclusive
    checkpointStartSample = endSampleExclusive
    silenceAccumulatedMs = 0.0
  }

  private fun rmsDb(samples: FloatArray): Double {
    if (samples.isEmpty()) return -120.0
    var sum = 0.0
    for (value in samples) {
      sum += value * value
    }
    val rms = sqrt(sum / samples.size)
    if (rms <= 1e-9) return -120.0
    return 20.0 * log10(rms)
  }

  override fun evaluateAudioChunk(
    chunk: FloatArray,
    sampleRate: Int,
    totalSamplesWritten: Long,
  ) {
    if (currentState != EngineState.ACTIVE) return
    if (chunk.isEmpty() || sampleRate <= 0) return

    if (policy.evaluator == "continuous_frames") {
      if (policy.checkpointIntervalMs <= 0) return
      val checkpointDurationMs =
        ((totalSamplesWritten - checkpointStartSample).coerceAtLeast(0L) * 1000.0) /
          sampleRate
      if (checkpointDurationMs >= policy.checkpointIntervalMs) {
        appendSegment(
          endSampleExclusive = totalSamplesWritten,
          reason = "policy_checkpoint",
          source = "segmentation_engine",
          score = rmsDb(chunk),
        )
      }
      return
    }

    val chunkDurationMs = (chunk.size * 1000.0) / sampleRate
    val db = rmsDb(chunk)
    if (db < policy.energyThresholdDb) {
      silenceAccumulatedMs += chunkDurationMs
    } else {
      silenceAccumulatedMs = 0.0
    }

    val segmentDurationMs =
      ((totalSamplesWritten - segmentStartSample).coerceAtLeast(0L) * 1000.0) /
        sampleRate

    if (
      silenceAccumulatedMs >=
      (policy.silenceThresholdMs + policy.hangoverMs).toDouble() &&
      segmentDurationMs >= policy.minSegmentMs
    ) {
      appendSegment(
        endSampleExclusive = totalSamplesWritten,
        reason = "energy_silence",
        source = "segmentation_engine",
        score = db,
      )
      return
    }

    if (segmentDurationMs >= policy.maxSegmentMs) {
      appendSegment(
        endSampleExclusive = totalSamplesWritten,
        reason = "length_limit",
        source = "segmentation_engine",
        score = db,
      )
      return
    }

  }

  override fun flush() {
    if (currentState != EngineState.ACTIVE) return
    val live = PipelineAudioRegistry.getLive(attachedBufferId) ?: return
    val endSampleExclusive = live.totalSamplesWritten

    if (policy.evaluator == "continuous_frames") {
      if (endSampleExclusive > segmentStartSample) {
        appendSegment(
          endSampleExclusive = endSampleExclusive,
          reason = "finalize",
          source = "segmentation_engine",
          score = null,
        )
      }
      return
    }

    if (endSampleExclusive > segmentStartSample) {
      appendSegment(
        endSampleExclusive = endSampleExclusive,
        reason = "finalize",
        source = "segmentation_engine",
        score = null,
      )
    }
  }
}

private fun resolveVadRuntime(
  policy: SegmentationEnginePolicy,
  sampleRate: Int,
): Pair<VadRuntime, VadRuntimeOptions> {
  val pathRaw = policy.modelPath
    ?: throw SegmentationEngineException(
      code = "POLICY_MODEL_UNAVAILABLE",
      message = "speech_vad_model requires policy.modelPath",
    )

  val modelPath = pathRaw.trim()
  if (modelPath.isEmpty()) {
    throw SegmentationEngineException(
      code = "POLICY_MODEL_UNAVAILABLE",
      message = "speech_vad_model requires non-empty policy.modelPath",
    )
  }
  val onnxFile = File(modelPath)
  if (!onnxFile.isFile) {
    throw SegmentationEngineException(
      code = "POLICY_MODEL_UNAVAILABLE",
      message = "speech_vad_model modelPath must be an existing .onnx file: $modelPath",
    )
  }
  val modelType =
    policy.modelType?.trim()
      ?: throw SegmentationEngineException(
        code = "POLICY_MODEL_UNAVAILABLE",
        message = "speech_vad_model requires policy.modelType from VAD detection",
      )
  if (modelType != "silero_vad" && modelType != "ten_vad") {
    throw SegmentationEngineException(
      code = "POLICY_MODEL_UNAVAILABLE",
      message = "speech_vad_model unsupported modelType: $modelType",
    )
  }
  val baseRuntimeOptions = defaultRuntimeOptions(modelType)
  val overridden = withRuntimeOverrides(
    base = baseRuntimeOptions,
    scoreThreshold = policy.vadThreshold,
    minSpeechDurationMs =
      policy.vadMinSpeechMs ?: baseRuntimeOptions.minSpeechDurationMs,
    minSilenceDurationMs =
      policy.vadMinSilenceMs ?: baseRuntimeOptions.minSilenceDurationMs,
    windowSize = null,
    maxSpeechDurationMs = policy.maxSegmentMs,
  )

  val runtimeOptions = when (modelType) {
    "silero_vad" -> overridden as? VadRuntimeOptions.Silero
    "ten_vad" -> overridden as? VadRuntimeOptions.Ten
    else -> null
  } ?: throw SegmentationEngineException(
    code = "POLICY_MODEL_UNAVAILABLE",
    message = "speech_vad_model options mismatch for modelType=$modelType",
  )

  val runtime = try {
    createVadRuntime(
      modelType = modelType,
      modelPath = onnxFile.absolutePath,
      sampleRate = sampleRate,
      provider = "cpu",
      numThreads = 1,
      debug = false,
      runtimeOptions = runtimeOptions,
    )
  } catch (e: Exception) {
    throw SegmentationEngineException(
      code = "POLICY_MODEL_UNAVAILABLE",
      message =
        "speech_vad_model failed to initialize runtime: ${e.message ?: "unknown error"}",
    )
  }

  return Pair(runtime, runtimeOptions)
}

private class SpeechVadModelEngine(
  engineId: String,
  attachedBufferId: String,
  policy: SegmentationEnginePolicy,
  override val segmentBufferId: String,
  private val runtime: VadRuntime,
  private val runtimeOptions: VadRuntimeOptions,
) : BaseSegmentationEngine(
  engineId = engineId,
  domain = EngineDomain.SPEECH,
  attachedBufferId = attachedBufferId,
  policy = policy,
) {
  private var processedSamples: Long = 0L
  private var segmentStartSample: Long = 0L
  private var speechSamples: Long = 0L
  private var silenceSamples: Long = 0L
  private var speechScoreSum: Double = 0.0
  private var speechScoreCount: Int = 0
  private var pendingVadSamples: FloatArray = FloatArray(0)

  private fun samplesToMs(samples: Long, sampleRate: Int): Long {
    if (sampleRate <= 0) return 0L
    return (samples * 1000L) / sampleRate.toLong()
  }

  private fun resetSpeechState(nextSegmentStart: Long) {
    segmentStartSample = nextSegmentStart
    speechSamples = 0L
    silenceSamples = 0L
    speechScoreSum = 0.0
    speechScoreCount = 0
  }

  private fun appendSegment(
    endSampleExclusive: Long,
    sampleRate: Int,
    reason: String,
    score: Double?,
  ) {
    if (endSampleExclusive <= segmentStartSample) {
      resetSpeechState(endSampleExclusive)
      return
    }

    val durationMs = samplesToMs(endSampleExclusive - segmentStartSample, sampleRate)
    if (durationMs < runtimeOptions.minSpeechDurationMs.toLong()) {
      resetSpeechState(endSampleExclusive)
      return
    }

    val segEntry = SegmentPipelineRegistry.getLive(segmentBufferId) ?: return
    val payload = JSONObject()
      .put("source", "vad")
      .put("engine", "vad")
      .put("decision", "model")
    if (score != null && score.isFinite()) {
      payload.put("score", score)
    }

    val (segmentId, _) = segEntry.appendSegment(
      kind = "speech",
      sourceAudioBufferId = attachedBufferId,
      startSample = segmentStartSample.toInt(),
      endSample = endSampleExclusive.toInt(),
      sampleRate = sampleRate,
      durationMs = durationMs.toInt(),
      confidence = null,
      payloadJson = payload.toString(),
      annotationReason = reason,
      annotationSource = "segmentation_engine",
      annotationCreatedAtMs = nowMs(),
    )

    totalSegmentsCommitted += 1
    lastSegmentId = segmentId
    resetSpeechState(endSampleExclusive)
  }

  private fun processVadFrame(
    frame: FloatArray,
    effectiveSamples: Int,
    sampleRate: Int,
  ) {
    if (effectiveSamples <= 0) return

    val decision = runtime.infer(frame, sampleRate)
    if (decision.isSpeech) {
      if (speechSamples == 0L) {
        segmentStartSample = processedSamples
      }
      speechSamples += effectiveSamples.toLong()
      silenceSamples = 0L
      if (decision.score != null) {
        speechScoreSum += decision.score
        speechScoreCount += 1
      }
    } else if (speechSamples > 0L) {
      silenceSamples += effectiveSamples.toLong()
      if (samplesToMs(silenceSamples, sampleRate) >= runtimeOptions.minSilenceDurationMs.toLong()) {
        val avgScore = if (speechScoreCount > 0) {
          speechScoreSum / speechScoreCount.toDouble()
        } else {
          null
        }
        appendSegment(
          endSampleExclusive = segmentStartSample + speechSamples,
          sampleRate = sampleRate,
          reason = "vad_boundary",
          score = avgScore,
        )
      }
    }

    if (
      speechSamples > 0L &&
      samplesToMs(speechSamples, sampleRate) >= policy.maxSegmentMs.toLong()
    ) {
      val avgScore = if (speechScoreCount > 0) {
        speechScoreSum / speechScoreCount.toDouble()
      } else {
        null
      }
      appendSegment(
        endSampleExclusive = segmentStartSample + speechSamples,
        sampleRate = sampleRate,
        reason = "length_limit",
        score = avgScore,
      )
    }

    processedSamples += effectiveSamples.toLong()
  }

  override fun evaluateAudioChunk(
    chunk: FloatArray,
    sampleRate: Int,
    totalSamplesWritten: Long,
  ) {
    if (currentState != EngineState.ACTIVE) return
    if (chunk.isEmpty() || sampleRate <= 0) return

    val frameSize = runtimeOptions.windowSize.coerceAtLeast(1)
    val merged = FloatArray(pendingVadSamples.size + chunk.size)
    pendingVadSamples.copyInto(merged, 0, 0, pendingVadSamples.size)
    chunk.copyInto(merged, pendingVadSamples.size, 0, chunk.size)

    var offset = 0
    while (offset + frameSize <= merged.size) {
      val frame = merged.copyOfRange(offset, offset + frameSize)
      processVadFrame(frame, frameSize, sampleRate)
      offset += frameSize
    }

    pendingVadSamples = if (offset < merged.size) {
      merged.copyOfRange(offset, merged.size)
    } else {
      FloatArray(0)
    }
  }

  override fun flush() {
    if (currentState != EngineState.ACTIVE) return
    val live = PipelineAudioRegistry.getLive(attachedBufferId) ?: return
    val sampleRate = live.sampleRate

    val frameSize = runtimeOptions.windowSize.coerceAtLeast(1)
    if (pendingVadSamples.isNotEmpty()) {
      val tail = FloatArray(frameSize)
      pendingVadSamples.copyInto(tail, 0, 0, pendingVadSamples.size)
      processVadFrame(tail, pendingVadSamples.size, sampleRate)
      pendingVadSamples = FloatArray(0)
    }

    if (speechSamples > 0L) {
      appendSegment(
        endSampleExclusive = segmentStartSample + speechSamples,
        sampleRate = sampleRate,
        reason = "finalize",
        score = null,
      )
    }
  }

  override fun release() {
    super.release()
    runtime.close()
  }
}

private fun normalizeDomain(raw: String): EngineDomain {
  return when (raw.lowercase()) {
    "text" -> EngineDomain.TEXT
    "speech" -> EngineDomain.SPEECH
    else -> throw SegmentationEngineException(
      code = "POLICY_INVALID",
      message = "Unsupported segmentation domain: $raw",
    )
  }
}

private fun readInt(map: Map<String, Any?>, key: String, defaultValue: Int): Int {
  val raw = map[key] as? Number ?: return defaultValue
  return raw.toInt()
}

private fun readDouble(
  map: Map<String, Any?>,
  key: String,
  defaultValue: Double,
): Double {
  val raw = map[key] as? Number ?: return defaultValue
  return raw.toDouble()
}

private fun readBoolean(
  map: Map<String, Any?>,
  key: String,
  defaultValue: Boolean,
): Boolean {
  val raw = map[key] as? Boolean ?: return defaultValue
  return raw
}

private fun readString(
  map: Map<String, Any?>,
  key: String,
): String? {
  val raw = map[key] as? String ?: return null
  val trimmed = raw.trim()
  return if (trimmed.isEmpty()) null else trimmed
}

private fun readSentenceBoundaryChars(
  map: Map<String, Any?>,
): List<String>? {
  val raw = map["sentenceBoundaryChars"] ?: return null
  val list = raw as? List<*>
    ?: throw SegmentationEngineException(
      code = "POLICY_INVALID",
      message = "sentenceBoundaryChars must be an array of strings",
    )
  val out = ArrayList<String>()
  for (item in list) {
    val s = item as? String
      ?: throw SegmentationEngineException(
        code = "POLICY_INVALID",
        message = "sentenceBoundaryChars must only contain strings",
      )
    if (s.isEmpty()) continue
    if (s.length > MAX_SENTENCE_BOUNDARY_DELIMITER_STRLEN) {
      throw SegmentationEngineException(
        code = "POLICY_INVALID",
        message =
          "sentenceBoundaryChars entries must be at most $MAX_SENTENCE_BOUNDARY_DELIMITER_STRLEN characters",
      )
    }
    out.add(s)
  }
  if (out.isEmpty()) return null
  if (out.size > MAX_SENTENCE_BOUNDARY_DELIMITER_ENTRIES) {
    throw SegmentationEngineException(
      code = "POLICY_INVALID",
      message =
        "sentenceBoundaryChars must have at most $MAX_SENTENCE_BOUNDARY_DELIMITER_ENTRIES entries",
    )
  }
  return out
}

private fun parsePolicy(
  domain: EngineDomain,
  rawPolicy: Map<String, Any?>,
): SegmentationEnginePolicy {
  val defaultEvaluator = if (domain == EngineDomain.TEXT) {
    "text_synthetic_auto"
  } else {
    "speech_energy_silence"
  }
  val evaluator = (rawPolicy["evaluator"] as? String)?.trim()?.lowercase()
    ?: defaultEvaluator

  val textEvaluators = setOf("text_synthetic_auto", "text_punctuation_assisted")
  val speechEvaluators = setOf(
    "speech_energy_silence",
    "speech_vad_model",
    "continuous_frames",
  )

  when (domain) {
    EngineDomain.TEXT -> if (!textEvaluators.contains(evaluator)) {
      throw SegmentationEngineException(
        code = "POLICY_INVALID",
        message = "Policy evaluator '$evaluator' is invalid for text domain",
      )
    }

    EngineDomain.SPEECH -> if (!speechEvaluators.contains(evaluator)) {
      throw SegmentationEngineException(
        code = "POLICY_INVALID",
        message = "Policy evaluator '$evaluator' is invalid for speech domain",
      )
    }
  }

  val minSegmentMs = readInt(rawPolicy, "minSegmentMs", 1000).coerceAtLeast(100)
  val maxSegmentMs = readInt(rawPolicy, "maxSegmentMs", 120000)
    .coerceAtLeast(200)
    .coerceAtLeast(minSegmentMs)

  return SegmentationEnginePolicy(
    evaluator = evaluator,
    maxLengthChars = readInt(rawPolicy, "maxLengthChars", 2000).coerceAtLeast(1),
    sentenceBoundary = readBoolean(rawPolicy, "sentenceBoundary", true),
    sentenceBoundaryChars = readSentenceBoundaryChars(rawPolicy),
    silenceThresholdMs = readInt(rawPolicy, "silenceThresholdMs", 500).coerceAtLeast(50),
    energyThresholdDb = readDouble(rawPolicy, "energyThresholdDb", -40.0),
    minSegmentMs = minSegmentMs,
    maxSegmentMs = maxSegmentMs,
    hangoverMs = readInt(rawPolicy, "hangoverMs", 300).coerceAtLeast(0),
    checkpointIntervalMs =
      readInt(rawPolicy, "checkpointIntervalMs", 0).coerceAtLeast(0),
    punctuationInstanceId = readString(rawPolicy, "punctuationInstanceId"),
    modelPath = readString(rawPolicy, "modelPath"),
    modelType = readString(rawPolicy, "modelType"),
    vadThreshold = (rawPolicy["vadThreshold"] as? Number)?.toDouble(),
    vadMinSpeechMs = (rawPolicy["vadMinSpeechMs"] as? Number)?.toInt(),
    vadMinSilenceMs = (rawPolicy["vadMinSilenceMs"] as? Number)?.toInt(),
  )
}

object SegmentationEngineRegistry {
  private val engineById = ConcurrentHashMap<String, PaSegmentationEngine>()
  private val engineIdByBufferId = ConcurrentHashMap<String, String>()
  private val segmentAnnotationBySegmentId =
    ConcurrentHashMap<String, SegmentAnnotationSnapshot>()
  private val evaluatingBufferIds = ConcurrentHashMap.newKeySet<String>()

  private fun nextEngineId(): String = "seg_engine_${UUID.randomUUID()}"

  private fun requireLiveTextBuffer(bufferId: String): LiveTextEntry {
    return TextPipelineRegistry.getLive(bufferId)
      ?: throw SegmentationEngineException(
        code = "BUFFER_STATE_INVALID",
        message = "Live text buffer not found: $bufferId",
      )
  }

  private fun requireLiveAudioBuffer(bufferId: String): LiveEntry {
    return PipelineAudioRegistry.getLive(bufferId)
      ?: throw SegmentationEngineException(
        code = "BUFFER_STATE_INVALID",
        message = "Live audio buffer not found: $bufferId",
      )
  }

  private fun releaseExistingForBuffer(bufferId: String) {
    val prevEngineId = engineIdByBufferId.remove(bufferId) ?: return
    val prev = engineById.remove(prevEngineId)
    prev?.release()
  }

  fun attachEngine(
    bufferId: String,
    domainRaw: String,
    rawPolicy: Map<String, Any?>,
  ): SegmentationEngineInfoSnapshot {
    val domain = normalizeDomain(domainRaw)

    if (engineIdByBufferId.containsKey(bufferId)) {
      throw SegmentationEngineException(
        code = "ENGINE_ALREADY_ATTACHED",
        message = "Segmentation engine already attached for buffer: $bufferId",
      )
    }

    val policy = parsePolicy(domain, rawPolicy)
    val engineId = nextEngineId()

    val engine: PaSegmentationEngine = when (domain) {
      EngineDomain.TEXT -> {
        val entry = requireLiveTextBuffer(bufferId)
        if (entry.state != LiveTextEntry.State.RECORDING) {
          throw SegmentationEngineException(
            code = "BUFFER_STATE_INVALID",
            message = "Live text buffer is not in recording state: $bufferId",
          )
        }
        if (policy.evaluator == "text_punctuation_assisted") {
          val punctuationId = policy.punctuationInstanceId
            ?: throw SegmentationEngineException(
              code = "POLICY_PUNCTUATION_INSTANCE_NOT_FOUND",
              message = "text_punctuation_assisted requires policy.punctuationInstanceId",
            )
          if (
            !SherpaOnnxOnlinePunctuationHelper.hasOnlineInstance(punctuationId) &&
            !SherpaOnnxPunctuationHelper.hasOfflineInstance(punctuationId)
          ) {
            throw SegmentationEngineException(
              code = "POLICY_PUNCTUATION_INSTANCE_NOT_FOUND",
              message = "Punctuation instance not found for segmentation policy: $punctuationId",
            )
          }
          TextPunctuationAssistedEngine(
            engineId = engineId,
            attachedBufferId = bufferId,
            policy = policy,
          )
        } else {
          TextSyntheticAutoEngine(
            engineId = engineId,
            attachedBufferId = bufferId,
            policy = policy,
          )
        }
      }

      EngineDomain.SPEECH -> {
        val live = requireLiveAudioBuffer(bufferId)
        if (live.state != LiveEntry.State.RECORDING) {
          throw SegmentationEngineException(
            code = "BUFFER_STATE_INVALID",
            message = "Live audio buffer is not in recording state: $bufferId",
          )
        }

        val segmentEntry = SegmentPipelineRegistry.createLive(
          sourceAudioBufferId = bufferId,
          maxSegments = 4096,
          spoolingModeRaw = "on",
          spoolingPath = null,
          spoolingTemporary = null,
          spoolingThresholdBytes = 0L,
          emitSegmentAppendedEvents = true,
          segmentEventMinIntervalMs = 0L,
        )

        val effectivePolicy = if (policy.evaluator == "continuous_frames") {
          policy.copy(evaluator = "continuous_frames")
        } else {
          policy
        }

        if (effectivePolicy.evaluator == "speech_vad_model") {
          val (runtime, runtimeOptions) = resolveVadRuntime(
            policy = effectivePolicy,
            sampleRate = live.sampleRate,
          )
          SpeechVadModelEngine(
            engineId = engineId,
            attachedBufferId = bufferId,
            policy = effectivePolicy,
            segmentBufferId = segmentEntry.bufferId,
            runtime = runtime,
            runtimeOptions = runtimeOptions,
          )
        } else {
          SpeechEnergySilenceEngine(
            engineId = engineId,
            attachedBufferId = bufferId,
            policy = effectivePolicy,
            segmentBufferId = segmentEntry.bufferId,
          )
        }
      }
    }

    engineById[engineId] = engine
    engineIdByBufferId[bufferId] = engineId
    return engine.info()
  }

  fun detachEngine(engineId: String, flushFinal: Boolean) {
    val engine = engineById[engineId]
      ?: throw SegmentationEngineException(
        code = "ENGINE_DETACHED",
        message = "Segmentation engine not found: $engineId",
      )

    if (engine.state() != EngineState.ACTIVE) {
      throw SegmentationEngineException(
        code = "ENGINE_DETACHED",
        message = "Segmentation engine is detached: $engineId",
      )
    }

    if (flushFinal) {
      engine.flush()
    }
    engine.detach()
    engineIdByBufferId.remove(engine.attachedBufferId)
  }

  fun getEngineInfo(engineId: String): SegmentationEngineInfoSnapshot {
    val engine = engineById[engineId]
      ?: throw SegmentationEngineException(
        code = "ENGINE_DETACHED",
        message = "Segmentation engine not found: $engineId",
      )
    return engine.info()
  }

  fun onLiveTextWrite(bufferId: String) {
    val engineId = engineIdByBufferId[bufferId] ?: return
    val engine = engineById[engineId] ?: return
    if (engine.domain != EngineDomain.TEXT || engine.state() != EngineState.ACTIVE) {
      return
    }
    if (!evaluatingBufferIds.add(bufferId)) return
    try {
      engine.evaluateText()
    } finally {
      evaluatingBufferIds.remove(bufferId)
    }
  }

  fun onLiveAudioWrite(
    bufferId: String,
    chunk: FloatArray,
    sampleRate: Int,
    totalSamplesWritten: Long,
  ) {
    val engineId = engineIdByBufferId[bufferId] ?: return
    val engine = engineById[engineId] ?: return
    if (engine.domain != EngineDomain.SPEECH || engine.state() != EngineState.ACTIVE) {
      return
    }
    if (!evaluatingBufferIds.add(bufferId)) return
    try {
      engine.evaluateAudioChunk(chunk, sampleRate, totalSamplesWritten)
    } finally {
      evaluatingBufferIds.remove(bufferId)
    }
  }

  fun onBufferFinalized(bufferId: String) {
    val engineId = engineIdByBufferId[bufferId] ?: return
    val engine = engineById[engineId] ?: return
    if (engine.state() == EngineState.ACTIVE) {
      if (!evaluatingBufferIds.add(bufferId)) return
      try {
        engine.flush()
        engine.detach()
        engineIdByBufferId.remove(bufferId)
      } finally {
        evaluatingBufferIds.remove(bufferId)
      }
    }
  }

  fun onBufferReleased(bufferId: String) {
    val engineId = engineIdByBufferId.remove(bufferId) ?: return
    val engine = engineById.remove(engineId) ?: return
    engine.release()
  }

  fun releaseAll() {
    val ids = engineById.keys.toList()
    for (id in ids) {
      engineById.remove(id)?.release()
    }
    engineIdByBufferId.clear()
    segmentAnnotationBySegmentId.clear()
    evaluatingBufferIds.clear()
  }

  fun recordSegmentAnnotation(
    segmentId: String,
    annotation: SegmentAnnotationSnapshot,
  ) {
    segmentAnnotationBySegmentId[segmentId] = annotation
  }

  fun consumeSegmentAnnotation(segmentId: String): SegmentAnnotationSnapshot? {
    return segmentAnnotationBySegmentId.remove(segmentId)
  }

  fun peekSegmentAnnotation(segmentId: String): SegmentAnnotationSnapshot? {
    return segmentAnnotationBySegmentId[segmentId]
  }

  fun segmentOfflineBuffer(
    bufferId: String,
    domainRaw: String,
    rawPolicy: Map<String, Any?>,
  ): Map<String, Any?> {
    val domain = normalizeDomain(domainRaw)
    val policy = parsePolicy(domain, rawPolicy)

    return when (domain) {
      EngineDomain.TEXT -> {
        val offline = TextPipelineRegistry.getOffline(bufferId)
          ?: throw SegmentationEngineException(
            code = "BUFFER_STATE_INVALID",
            message = "Offline text buffer not found: $bufferId",
          )

        val rawText = offline.text
        val text = if (policy.evaluator == "text_punctuation_assisted") {
          val punctuationId = policy.punctuationInstanceId
            ?: throw SegmentationEngineException(
              code = "POLICY_PUNCTUATION_INSTANCE_NOT_FOUND",
              message = "text_punctuation_assisted requires policy.punctuationInstanceId",
            )
          resolvePunctuatedTextOrThrow(punctuationId, rawText)
        } else {
          rawText
        }
        var index = 0
        val records = ArrayList<Map<String, Any?>>()
        val offlineDelimiters = resolveSentenceBoundaryDelimiters(policy)
        while (index < text.length) {
          val remaining = text.substring(index)
          var split = -1
          var foundBoundary = false
          if (policy.sentenceBoundary) {
            val end = firstDelimiterEndExclusive(remaining, offlineDelimiters)
            if (end >= 0) {
              split = end
              foundBoundary = true
            }
          }
          if (split <= 0) {
            val maxLen = policy.maxLengthChars.coerceAtLeast(1)
            split = minOf(maxLen, remaining.length)
            if (split < remaining.length) {
              val prefix = remaining.substring(0, split)
              val spaceAt = prefix.lastIndexOf(' ')
              if (spaceAt > 0) {
                split = spaceAt + 1
              }
            }
          }
          val chunk = remaining.substring(0, split)
          val end = index + chunk.length
          val isFinalChunk = split >= remaining.length
          val reason = when {
            isFinalChunk -> "finalize"
            foundBoundary -> "punctuation"
            else -> "length_limit"
          }
          records.add(
            mapOf(
              "segmentId" to "txtseg_${bufferId}_${records.size}",
              "startOffset" to index,
              "endOffset" to end,
              "reason" to reason,
              "source" to "segmentation_engine",
              "text" to chunk,
            )
          )
          index = end
        }

        mapOf(
          "bufferId" to bufferId,
          "kind" to "offlineTextBuffer",
          "state" to "immutable",
          "segmentCount" to records.size,
          "segments" to records,
        )
      }

      EngineDomain.SPEECH -> {
        if (policy.evaluator == "continuous_frames") {
          throw SegmentationEngineException(
            code = "POLICY_INVALID_FOR_OFFLINE",
            message =
              "Policy evaluator 'continuous_frames' is streaming-only and invalid for offline segmentation",
          )
        }

        val offline = PipelineAudioRegistry.getOffline(bufferId)
          ?: throw SegmentationEngineException(
            code = "BUFFER_STATE_INVALID",
            message = "Offline audio buffer not found: $bufferId",
          )

        val sr = offline.sampleRate
        val records = ArrayList<SegmentRecord>()

        if (policy.evaluator == "speech_vad_model") {
          val (runtime, runtimeOptions) = resolveVadRuntime(policy, sr)
          try {
            val frameSize = runtimeOptions.windowSize.coerceAtLeast(1)
            val chunkSize = (frameSize * 8).coerceAtLeast(frameSize)
            var cursor = 0
            var processedSamples = 0
            var segmentStart = 0
            var speechSamples = 0
            var silenceSamples = 0
            var scoreSum = 0.0
            var scoreCount = 0
            var pending = FloatArray(0)

            fun samplesToMs(samples: Int): Int {
              if (sr <= 0) return 0
              return (samples * 1000) / sr
            }

            fun resetState(nextStartSample: Int) {
              segmentStart = nextStartSample
              speechSamples = 0
              silenceSamples = 0
              scoreSum = 0.0
              scoreCount = 0
            }

            fun appendVadRecord(reason: String, score: Double?) {
              val endExclusive = segmentStart + speechSamples
              if (endExclusive <= segmentStart) {
                resetState(processedSamples)
                return
              }
              val durationMs = samplesToMs(endExclusive - segmentStart)
              if (durationMs < runtimeOptions.minSpeechDurationMs) {
                resetState(processedSamples)
                return
              }

              val payload = JSONObject()
                .put("source", "vad")
                .put("engine", "vad")
                .put("decision", "model")
              if (score != null && score.isFinite()) {
                payload.put("score", score)
              }

              val record = SegmentRecord(
                id = "seg_${UUID.randomUUID()}",
                kind = "speech",
                sourceAudioBufferId = bufferId,
                startSample = segmentStart,
                endSample = endExclusive,
                sampleRate = sr,
                durationMs = durationMs,
                confidence = null,
                payloadJson = payload.toString(),
              )
              records.add(record)
              val segmentIndex = records.lastIndex
              recordSegmentAnnotation(
                record.id,
                SegmentAnnotationSnapshot(
                  reason = reason,
                  source = "segmentation_engine",
                  createdAtMs = nowMs(),
                  segmentIndex = segmentIndex,
                )
              )
              resetState(endExclusive)
            }

            fun processFrame(frame: FloatArray, effectiveSamples: Int) {
              if (effectiveSamples <= 0) return
              val decision = runtime.infer(frame, sr)

              if (decision.isSpeech) {
                if (speechSamples == 0) {
                  segmentStart = processedSamples
                }
                speechSamples += effectiveSamples
                silenceSamples = 0
                if (decision.score != null) {
                  scoreSum += decision.score
                  scoreCount += 1
                }
              } else if (speechSamples > 0) {
                silenceSamples += effectiveSamples
                if (samplesToMs(silenceSamples) >= runtimeOptions.minSilenceDurationMs) {
                  val avgScore = if (scoreCount > 0) {
                    scoreSum / scoreCount.toDouble()
                  } else {
                    null
                  }
                  appendVadRecord("vad_boundary", avgScore)
                }
              }

              if (speechSamples > 0 && samplesToMs(speechSamples) >= policy.maxSegmentMs) {
                val avgScore = if (scoreCount > 0) {
                  scoreSum / scoreCount.toDouble()
                } else {
                  null
                }
                appendVadRecord("length_limit", avgScore)
              }

              processedSamples += effectiveSamples
            }

            while (cursor < offline.numSamples) {
              val count = minOf(chunkSize, offline.numSamples - cursor)
              val chunk = offline.readSlice(cursor, count)
              cursor += chunk.size
              if (chunk.isEmpty()) break

              val merged = FloatArray(pending.size + chunk.size)
              pending.copyInto(merged, 0, 0, pending.size)
              chunk.copyInto(merged, pending.size, 0, chunk.size)

              var offset = 0
              while (offset + frameSize <= merged.size) {
                val frame = merged.copyOfRange(offset, offset + frameSize)
                processFrame(frame, frameSize)
                offset += frameSize
              }

              pending = if (offset < merged.size) {
                merged.copyOfRange(offset, merged.size)
              } else {
                FloatArray(0)
              }
            }

            if (pending.isNotEmpty()) {
              val tail = FloatArray(frameSize)
              pending.copyInto(tail, 0, 0, pending.size)
              processFrame(tail, pending.size)
              pending = FloatArray(0)
            }

            if (speechSamples > 0) {
              appendVadRecord("finalize", null)
            }
          } finally {
            runtime.close()
          }
        } else {
          val minSamples = ((policy.minSegmentMs.toDouble() * sr) / 1000.0).toInt().coerceAtLeast(1)
          val maxSamples = ((policy.maxSegmentMs.toDouble() * sr) / 1000.0).toInt().coerceAtLeast(minSamples)
          val silenceSamples =
            (((policy.silenceThresholdMs + policy.hangoverMs).toDouble() * sr) / 1000.0)
              .toInt()
              .coerceAtLeast(1)

          var start = 0
          var cursor = 0
          var silenceRun = 0
          val frameSize = (sr / 50).coerceAtLeast(160)

          while (cursor < offline.numSamples) {
            val readCount = minOf(frameSize, offline.numSamples - cursor)
            val frame = offline.readSlice(cursor, readCount)
            if (frame.isEmpty()) break
            val end = cursor + frame.size
            var sum = 0.0
            for (value in frame) {
              sum += value * value
            }
            val rms = if (frame.isEmpty()) 0.0 else sqrt(sum / frame.size)
            val db = if (rms <= 1e-9) -120.0 else 20.0 * log10(rms)
            if (db < policy.energyThresholdDb) {
              silenceRun += frame.size
            } else {
              silenceRun = 0
            }

            val segmentSize = end - start
            val shouldCommitSilence =
              silenceRun >= silenceSamples && segmentSize >= minSamples
            val shouldCommitLength = segmentSize >= maxSamples

            if (shouldCommitSilence || shouldCommitLength) {
              val reason = if (shouldCommitSilence) {
                "energy_silence"
              } else {
                "length_limit"
              }
              val payload = JSONObject()
                .put("source", "vad")
                .put("engine", "vad")
                .put("decision", "model")
                .put("score", db)
                .toString()
              records.add(
                SegmentRecord(
                  id = "seg_${UUID.randomUUID()}",
                  kind = "speech",
                  sourceAudioBufferId = bufferId,
                  startSample = start,
                  endSample = end,
                  sampleRate = sr,
                  durationMs = (((end - start) * 1000.0) / sr).toInt(),
                  confidence = null,
                  payloadJson = payload,
                )
              )
              val segmentIndex = records.lastIndex
              recordSegmentAnnotation(
                records.last().id,
                SegmentAnnotationSnapshot(
                  reason = reason,
                  source = "segmentation_engine",
                  createdAtMs = nowMs(),
                  segmentIndex = segmentIndex,
                )
              )
              start = end
              silenceRun = 0
            }

            cursor = end
          }

          if (start < offline.numSamples) {
            val end = offline.numSamples
            val payload = JSONObject()
              .put("source", "vad")
              .put("engine", "vad")
              .put("decision", "model")
              .toString()
            records.add(
              SegmentRecord(
                id = "seg_${UUID.randomUUID()}",
                kind = "speech",
                sourceAudioBufferId = bufferId,
                startSample = start,
                endSample = end,
                sampleRate = sr,
                durationMs = (((end - start) * 1000.0) / sr).toInt(),
                confidence = null,
                payloadJson = payload,
              )
            )
            val segmentIndex = records.lastIndex
            recordSegmentAnnotation(
              records.last().id,
              SegmentAnnotationSnapshot(
                reason = "finalize",
                source = "segmentation_engine",
                createdAtMs = nowMs(),
                segmentIndex = segmentIndex,
              )
            )
          }
        }

        val offlineSegment = SegmentPipelineRegistry.createEmptyOffline(bufferId)
        offlineSegment.populate(records)
        mapOf(
          "bufferId" to offlineSegment.bufferId,
          "kind" to "offlineSegmentBuffer",
          "state" to "immutable",
          "segmentCount" to records.size,
          "sourceAudioBufferId" to bufferId,
        )
      }
    }
  }

  private fun nowMs(): Long = System.currentTimeMillis()

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
