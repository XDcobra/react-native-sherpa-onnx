package com.sherpaonnx.segment.core

import java.util.LinkedHashMap
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

private data class SegmentLinkMapStore(
  val linkMapId: String,
  val textBufferId: String? = null,
  val audioBufferId: String? = null,
  val links: LinkedHashMap<String, SegmentLink> = LinkedHashMap(),
  val textIndex: MutableMap<String, LinkedHashSet<String>> = mutableMapOf(),
  val speechIndex: MutableMap<String, LinkedHashSet<String>> = mutableMapOf(),
  val pairTypeIndex: MutableSet<String> = mutableSetOf(),
)

object SegmentLinkMapRegistry {
  private val stores = ConcurrentHashMap<String, SegmentLinkMapStore>()

  private fun newLinkMapId(): String = "lnkmap_${UUID.randomUUID()}"
  private fun newLinkId(): String = "lnk_${UUID.randomUUID()}"

  private fun SegmentLinkType.raw(): String = name.lowercase()

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

  private fun requireStore(linkMapId: String): SegmentLinkMapStore {
    return stores[linkMapId]
      ?: throw IllegalArgumentException("SEGMENT_LINK_MAP_NOT_FOUND: link map not found: $linkMapId")
  }

  fun createLinkMap(
    textBufferId: String? = null,
    audioBufferId: String? = null,
  ): SegmentLinkMapRef {
    val linkMapId = newLinkMapId()
    stores[linkMapId] = SegmentLinkMapStore(
      linkMapId = linkMapId,
      textBufferId = textBufferId,
      audioBufferId = audioBufferId,
    )
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
    if (textSegmentId.isBlank()) {
      throw IllegalArgumentException("SEGMENT_LINK_INVALID: textSegmentId must be non-empty")
    }
    if (speechSegmentId.isBlank()) {
      throw IllegalArgumentException("SEGMENT_LINK_INVALID: speechSegmentId must be non-empty")
    }

    val store = requireStore(linkMapId)
    val linkType = parseLinkType(linkTypeRaw)
    val duplicateKey = "${textSegmentId}::${speechSegmentId}::${linkType.raw()}"
    if (store.pairTypeIndex.contains(duplicateKey)) {
      throw IllegalArgumentException(
        "SEGMENT_LINK_INVALID: duplicate (textSegmentId, speechSegmentId, linkType) is not allowed"
      )
    }

    val link = SegmentLink(
      linkId = newLinkId(),
      textSegmentId = textSegmentId,
      speechSegmentId = speechSegmentId,
      linkType = linkType,
      confidence = confidence,
      metaJson = metaJson,
    )

    store.links[link.linkId] = link
    store.pairTypeIndex.add(duplicateKey)

    val textSet = store.textIndex.getOrPut(textSegmentId) { linkedSetOf() }
    textSet.add(link.linkId)

    val speechSet = store.speechIndex.getOrPut(speechSegmentId) { linkedSetOf() }
    speechSet.add(link.linkId)

    return link
  }

  @Synchronized
  fun addLinks(
    linkMapId: String,
    links: List<SegmentLinkInput>,
  ): List<SegmentLink> {
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
        )
      )
    }
    return out
  }

  @Synchronized
  fun removeLink(linkMapId: String, linkId: String) {
    val store = requireStore(linkMapId)
    val removed = store.links.remove(linkId) ?: return

    val duplicateKey =
      "${removed.textSegmentId}::${removed.speechSegmentId}::${removed.linkType.name.lowercase()}"
    store.pairTypeIndex.remove(duplicateKey)

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
  fun getSpeechSegmentsForText(
    linkMapId: String,
    textSegmentId: String,
  ): List<SegmentLink> {
    val store = requireStore(linkMapId)
    val ids = store.textIndex[textSegmentId] ?: return emptyList()
    return ids.mapNotNull { id -> store.links[id] }
  }

  @Synchronized
  fun getTextSegmentsForSpeech(
    linkMapId: String,
    speechSegmentId: String,
  ): List<SegmentLink> {
    val store = requireStore(linkMapId)
    val ids = store.speechIndex[speechSegmentId] ?: return emptyList()
    return ids.mapNotNull { id -> store.links[id] }
  }

  @Synchronized
  fun getAllLinks(
    linkMapId: String,
    startIndex: Int,
    maxCount: Int,
  ): List<SegmentLink> {
    val store = requireStore(linkMapId)
    if (maxCount <= 0 || startIndex < 0) return emptyList()
    val all = store.links.values.toList()
    if (startIndex >= all.size) return emptyList()
    val end = minOf(startIndex + maxCount, all.size)
    return all.subList(startIndex, end)
  }

  @Synchronized
  fun getCount(linkMapId: String): Int = requireStore(linkMapId).links.size

  @Synchronized
  fun getInfo(linkMapId: String): SegmentLinkMapInfo {
    val store = requireStore(linkMapId)
    return SegmentLinkMapInfo(
      linkMapId = linkMapId,
      linkCount = store.links.size,
      textBufferId = store.textBufferId,
      audioBufferId = store.audioBufferId,
    )
  }

  fun release(linkMapId: String) {
    stores.remove(linkMapId)
  }

  fun releaseAll() {
    stores.clear()
  }
}

data class SegmentLinkInput(
  val textSegmentId: String,
  val speechSegmentId: String,
  val linkType: String,
  val confidence: Float? = null,
  val metaJson: String? = null,
)
