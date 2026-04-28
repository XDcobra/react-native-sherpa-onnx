package com.sherpaonnx.segment.core

import org.json.JSONArray
import org.json.JSONObject

/**
 * Phase 1a helper serialization for segment contract types.
 * Pure helpers; no behavior changes in existing pipelines.
 */

private fun SegmentReason.raw(): String = name.lowercase()
private fun SegmentSource.raw(): String = name.lowercase()
private fun SegmentDomain.raw(): String = if (this == SegmentDomain.TEXT) "text" else "speech"
private fun SegmentLinkType.raw(): String = name.lowercase()

fun Segment.toJson(): JSONObject {
  val base = JSONObject()
    .put("segmentId", segmentId)
    .put("domain", domain.raw())
    .put("startOffset", startOffset)
    .put("endOffset", endOffset)
    .put("reason", reason.raw())
    .put("source", source.raw())
    .put("createdAtMs", createdAtMs)
    .put("segmentIndex", segmentIndex)

  return when (this) {
    is TextSegment -> {
      base.put("text", text)
      base.put("utf16Length", utf16Length)
      tokens?.let { arr -> base.put("tokens", JSONArray(arr)) }
      timestamps?.let { arr ->
        val out = JSONArray()
        arr.forEach { out.put(it.toDouble()) }
        base.put("timestamps", out)
      }
      lang?.let { base.put("lang", it) }
      meta?.let { base.put("meta", JSONObject(it)) }
      base
    }
    is SpeechSegment -> {
      base.put("sourceAudioBufferId", sourceAudioBufferId)
      base.put("sampleRate", sampleRate)
      base.put("durationMs", durationMs.toDouble())
      confidence?.let { base.put("confidence", it.toDouble()) }
      energy?.let { base.put("energy", it.toDouble()) }
      vadInfo?.let {
        val v = JSONObject()
        it.engine?.let { e -> v.put("engine", e) }
        it.decision?.let { d -> v.put("decision", d) }
        it.score?.let { s -> v.put("score", s.toDouble()) }
        base.put("vadInfo", v)
      }
      meta?.let { base.put("meta", JSONObject(it)) }
      base
    }
  }
}

fun SegmentLink.toJson(): JSONObject {
  val out = JSONObject()
    .put("linkId", linkId)
    .put("textSegmentId", textSegmentId)
    .put("speechSegmentId", speechSegmentId)
    .put("linkType", linkType.raw())
  confidence?.let { out.put("confidence", it.toDouble()) }
  metaJson?.let { raw ->
    try {
      out.put("meta", JSONObject(raw))
    } catch (_: Exception) {
      out.put("meta", raw)
    }
  }
  return out
}

