package com.sherpaonnx.segment.core

import com.sherpaonnx.SherpaOnnxNativeLoader
import java.util.concurrent.ConcurrentHashMap

/**
 * Facade over shared C++ SegmentLinkMapRegistry (`slm_*`).
 * Kotlin keeps a mirror of links for query APIs until S3 closed fully via JNI getters.
 */
object SegmentLinkMapRegistry {
  init {
    SherpaOnnxNativeLoader.ensureLoaded()
  }

  private data class Mirror(
    val textBufferId: String?,
    val audioBufferId: String?,
    val links: LinkedHashMap<String, SegmentLink> = LinkedHashMap(),
    val textIndex: MutableMap<String, LinkedHashSet<String>> = mutableMapOf(),
    val speechIndex: MutableMap<String, LinkedHashSet<String>> = mutableMapOf(),
  )

  private val mirrors = ConcurrentHashMap<String, Mirror>()

  private fun parseLinkType(raw: String): SegmentLinkType {
    return when (raw.trim().lowercase()) {
      "alignment" -> SegmentLinkType.ALIGNMENT
      "proportional" -> SegmentLinkType.PROPORTIONAL
      "vad_assisted" -> SegmentLinkType.VAD_ASSISTED
      "sequential" -> SegmentLinkType.SEQUENTIAL
      "tts_produced" -> SegmentLinkType.TTS_PRODUCED
      "stt_produced" -> SegmentLinkType.STT_PRODUCED
      "user_defined" -> SegmentLinkType.USER_DEFINED
      else -> throw IllegalArgumentException("SEGMENT_LINK_INVALID: invalid linkType '$raw'")
    }
  }

  private fun requireMirror(linkMapId: String): Mirror {
    return mirrors[linkMapId]
      ?: throw IllegalArgumentException("SEGMENT_LINK_MAP_NOT_FOUND: link map not found: $linkMapId")
  }

  fun createLinkMap(
    textBufferId: String? = null,
    audioBufferId: String? = null,
  ): SegmentLinkMapRef {
    val linkMapId =
      SegmentLinkMapNative.nativeCreate(textBufferId, audioBufferId)
        ?: throw IllegalStateException("Failed to create segment link map")
    mirrors[linkMapId] = Mirror(textBufferId, audioBufferId)
    return SegmentLinkMapRef(linkMapId)
  }

  @Synchronized
  fun addLink(
    linkMapId: String,
    textSegmentId: String,
    speechSegmentId: String,
    linkTypeRaw: String,
    confidence: Float? = null,
    metaJson: String? = null,
  ): SegmentLink {
    val linkId =
      SegmentLinkMapNative.nativeAddLink(
        linkMapId,
        textSegmentId,
        speechSegmentId,
        linkTypeRaw,
        confidence != null,
        confidence ?: 0f,
        metaJson,
      )
        ?: throw IllegalArgumentException("SEGMENT_LINK_INVALID: addLink failed")
    val store = requireMirror(linkMapId)
    val link =
      SegmentLink(
        linkId = linkId,
        textSegmentId = textSegmentId,
        speechSegmentId = speechSegmentId,
        linkType = parseLinkType(linkTypeRaw),
        confidence = confidence,
        metaJson = metaJson,
      )
    store.links[link.linkId] = link
    store.textIndex.getOrPut(textSegmentId) { linkedSetOf() }.add(link.linkId)
    store.speechIndex.getOrPut(speechSegmentId) { linkedSetOf() }.add(link.linkId)
    return link
  }

  @Synchronized
  fun addLinks(linkMapId: String, links: List<SegmentLinkInput>): List<SegmentLink> {
    val out = ArrayList<SegmentLink>(links.size)
    for (input in links) {
      out.add(
        addLink(
          linkMapId = linkMapId,
          textSegmentId = input.textSegmentId,
          speechSegmentId = input.speechSegmentId,
          linkTypeRaw = input.linkType,
          confidence = input.confidence,
          metaJson = input.metaJson,
        ),
      )
    }
    return out
  }

  @Synchronized
  fun removeLink(linkMapId: String, linkId: String) {
    SegmentLinkMapNative.nativeRemoveLink(linkMapId, linkId)
    val store = mirrors[linkMapId] ?: return
    val removed = store.links.remove(linkId) ?: return
    store.textIndex[removed.textSegmentId]?.let { set ->
      set.remove(linkId)
      if (set.isEmpty()) store.textIndex.remove(removed.textSegmentId)
    }
    store.speechIndex[removed.speechSegmentId]?.let { set ->
      set.remove(linkId)
      if (set.isEmpty()) store.speechIndex.remove(removed.speechSegmentId)
    }
  }

  @Synchronized
  fun getSpeechSegmentsForText(linkMapId: String, textSegmentId: String): List<SegmentLink> {
    val store = requireMirror(linkMapId)
    val ids = store.textIndex[textSegmentId] ?: return emptyList()
    return ids.mapNotNull { id -> store.links[id] }
  }

  @Synchronized
  fun getTextSegmentsForSpeech(linkMapId: String, speechSegmentId: String): List<SegmentLink> {
    val store = requireMirror(linkMapId)
    val ids = store.speechIndex[speechSegmentId] ?: return emptyList()
    return ids.mapNotNull { id -> store.links[id] }
  }

  @Synchronized
  fun getAllLinks(linkMapId: String, startIndex: Int, maxCount: Int): List<SegmentLink> {
    val store = requireMirror(linkMapId)
    if (maxCount <= 0 || startIndex < 0) return emptyList()
    val all = store.links.values.toList()
    if (startIndex >= all.size) return emptyList()
    val end = minOf(startIndex + maxCount, all.size)
    return all.subList(startIndex, end)
  }

  @Synchronized
  fun getCount(linkMapId: String): Int {
    val n = SegmentLinkMapNative.nativeGetCount(linkMapId)
    return if (n >= 0) n else requireMirror(linkMapId).links.size
  }

  @Synchronized
  fun getInfo(linkMapId: String): SegmentLinkMapInfo {
    val store = requireMirror(linkMapId)
    return SegmentLinkMapInfo(
      linkMapId = linkMapId,
      linkCount = store.links.size,
      textBufferId = store.textBufferId,
      audioBufferId = store.audioBufferId,
    )
  }

  fun release(linkMapId: String) {
    mirrors.remove(linkMapId)
    SegmentLinkMapNative.nativeRelease(linkMapId)
  }

  fun releaseAll() {
    for (id in mirrors.keys.toList()) {
      release(id)
    }
  }
}

data class SegmentLinkInput(
  val textSegmentId: String,
  val speechSegmentId: String,
  val linkType: String,
  val confidence: Float? = null,
  val metaJson: String? = null,
)
