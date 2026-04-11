package com.sherpaonnx.text.pipeline

import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Unified pipeline text buffer registry.
 *
 * Manages both OfflineTextEntry (immutable text) and LiveTextEntry (streaming text).
 * Thread-safe via ConcurrentHashMap. Buffer IDs are prefixed for runtime type checking:
 * - `txt_off_…` for OfflineTextEntry
 * - `txt_live_…` for LiveTextEntry
 */
object TextPipelineRegistry {

  private val offlineEntries = ConcurrentHashMap<String, OfflineTextEntry>()
  private val liveEntries = ConcurrentHashMap<String, LiveTextEntry>()

  // ==================== Offline Buffer Creation ====================

  /**
   * Create an empty offline text buffer as output target (e.g. for STT).
   * The buffer starts unpopulated; callers fill it via [getOffline] + [OfflineTextEntry.populate].
   */
  fun createEmptyOffline(): OfflineTextEntry {
    val bufferId = "txt_off_${UUID.randomUUID()}"
    val entry = OfflineTextEntry(bufferId = bufferId)
    offlineEntries[bufferId] = entry
    return entry
  }

  /**
   * Create an offline text buffer pre-populated with the given text (e.g. for TTS input).
   * The buffer is marked as populated immediately.
   */
  fun createOfflineFromText(
    text: String,
    lang: String = "",
    emotion: String = "",
    event: String = ""
  ): OfflineTextEntry {
    val bufferId = "txt_off_${UUID.randomUUID()}"
    val entry = OfflineTextEntry(
      bufferId = bufferId,
      text = text,
      lang = lang,
      emotion = emotion,
      event = event,
      populated = true
    )
    offlineEntries[bufferId] = entry
    return entry
  }

  /**
   * Create an offline text buffer from a live text buffer snapshot.
   * @param liveBufferId ID of the live text buffer.
   * @param mode "fullIfSpooled" (full text if finalized, otherwise window snapshot) or "windowSnapshot" (always current window).
   */
  fun createOfflineFromLive(liveBufferId: String, mode: String = "fullIfSpooled"): OfflineTextEntry {
    val live = liveEntries[liveBufferId]
      ?: throw IllegalArgumentException("Live text buffer not found: $liveBufferId")

    val bufferId = "txt_off_${UUID.randomUUID()}"
    val text = live.snapshotText()

    val entry = OfflineTextEntry(
      bufferId = bufferId,
      text = text,
      populated = text.isNotEmpty()
    )
    offlineEntries[bufferId] = entry
    return entry
  }

  // ==================== Live Buffer Creation ====================

  /**
   * Create a new live text buffer.
   */
  fun createLive(
    windowMaxChars: Int = 65536,
    emitPartialEvents: Boolean = false,
    partialEventMinIntervalMs: Long = 0
  ): LiveTextEntry {
    val bufferId = "txt_live_${UUID.randomUUID()}"
    val entry = LiveTextEntry(
      bufferId = bufferId,
      windowMaxChars = windowMaxChars,
      emitPartialEvents = emitPartialEvents,
      partialEventMinIntervalMs = partialEventMinIntervalMs
    )
    liveEntries[bufferId] = entry
    return entry
  }

  /**
   * Create a live text buffer seeded from an offline text buffer.
   */
  fun createLiveFromOffline(offlineBufferId: String): LiveTextEntry {
    val offline = offlineEntries[offlineBufferId]
      ?: throw IllegalArgumentException("Offline text buffer not found: $offlineBufferId")

    val bufferId = "txt_live_${UUID.randomUUID()}"
    val entry = LiveTextEntry(bufferId = bufferId)
    if (offline.text.isNotEmpty()) {
      entry.writePartial(offline.text)
    }
    liveEntries[bufferId] = entry
    return entry
  }

  // ==================== Lookup ====================

  fun getOffline(bufferId: String): OfflineTextEntry? = offlineEntries[bufferId]

  fun getLive(bufferId: String): LiveTextEntry? = liveEntries[bufferId]

  // ==================== Release ====================

  /**
   * Release any text buffer (offline or live) by ID.
   * @return true if found and removed.
   */
  fun release(bufferId: String): Boolean {
    return offlineEntries.remove(bufferId) != null || liveEntries.remove(bufferId) != null
  }

  /**
   * Release all text buffers. For cleanup on module invalidate.
   */
  fun releaseAll() {
    offlineEntries.clear()
    liveEntries.clear()
  }
}
