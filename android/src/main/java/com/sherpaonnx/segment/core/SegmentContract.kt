package com.sherpaonnx.segment.core

/**
 * Phase 1a: canonical segment contract types.
 * Types only (no runtime behavior changes yet).
 */

sealed interface Segment {
  val segmentId: String
  val domain: SegmentDomain
  val startOffset: Long
  val endOffset: Long
  val reason: SegmentReason
  val source: SegmentSource
  val createdAtMs: Long
  val segmentIndex: Int
}

enum class SegmentDomain {
  TEXT,
  SPEECH,
}

enum class SegmentReason {
  ENDPOINT,
  PUNCTUATION,
  LENGTH_LIMIT,
  VAD_BOUNDARY,
  ENERGY_SILENCE,
  MANUAL_COMMIT,
  FINALIZE,
  POLICY_CHECKPOINT,
}

enum class SegmentSource {
  SEGMENTATION_ENGINE,
  MANUAL,
  EXTERNAL,
}

data class VadInfo(
  val engine: String? = null,
  val decision: String? = null,
  val score: Float? = null,
)

data class TextSegment(
  override val segmentId: String,
  override val startOffset: Long,
  override val endOffset: Long,
  override val reason: SegmentReason,
  override val source: SegmentSource,
  override val createdAtMs: Long,
  override val segmentIndex: Int,
  val text: String,
  val utf16Length: Int,
  val tokens: List<String>? = null,
  val timestamps: FloatArray? = null,
  val lang: String? = null,
  val meta: Map<String, Any?>? = null,
) : Segment {
  override val domain: SegmentDomain = SegmentDomain.TEXT
}

data class SpeechSegment(
  override val segmentId: String,
  override val startOffset: Long,
  override val endOffset: Long,
  override val reason: SegmentReason,
  override val source: SegmentSource,
  override val createdAtMs: Long,
  override val segmentIndex: Int,
  val sourceAudioBufferId: String,
  val sampleRate: Int,
  val durationMs: Float,
  val confidence: Float? = null,
  val energy: Float? = null,
  val vadInfo: VadInfo? = null,
  val meta: Map<String, Any?>? = null,
) : Segment {
  override val domain: SegmentDomain = SegmentDomain.SPEECH
}

