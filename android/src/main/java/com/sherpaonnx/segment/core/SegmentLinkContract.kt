package com.sherpaonnx.segment.core

/**
 * Phase 1a: cross-domain linkage contract types.
 * Types only (runtime map APIs are introduced in later phases).
 */

enum class SegmentLinkType {
  ALIGNMENT,
  PROPORTIONAL,
  VAD_ASSISTED,
  SEQUENTIAL,
  TTS_PRODUCED,
  STT_PRODUCED,
  USER_DEFINED,
}

data class SegmentLink(
  val linkId: String,
  val textSegmentId: String,
  val speechSegmentId: String,
  val linkType: SegmentLinkType,
  val confidence: Float? = null,
  val metaJson: String? = null,
)

data class SegmentLinkMapRef(
  val linkMapId: String,
)

data class SegmentLinkMapInfo(
  val linkMapId: String,
  val linkCount: Int,
  val textBufferId: String? = null,
  val audioBufferId: String? = null,
)

