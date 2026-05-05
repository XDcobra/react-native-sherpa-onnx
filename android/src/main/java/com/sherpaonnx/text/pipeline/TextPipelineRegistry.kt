package com.sherpaonnx.text.pipeline

import java.io.File
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

  @Volatile
  private var cacheDir: File? = null

  fun initializeWithCacheDir(dir: File) {
    cacheDir = dir
  }

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
   * @param mode "windowSnapshot" (always current window) or
   *             "fullIfSpooled" (strict full text from spool, otherwise TEXT_SPOOL_UNAVAILABLE).
   */
  fun createOfflineFromLive(liveBufferId: String, mode: String = "fullIfSpooled"): OfflineTextEntry {
    val live = liveEntries[liveBufferId]
      ?: throw IllegalArgumentException("Live text buffer not found: $liveBufferId")

    val bufferId = "txt_off_${UUID.randomUUID()}"
    val text = when (mode) {
      "windowSnapshot" -> live.snapshotText()
      "fullIfSpooled" -> live.snapshotFullTextIfSpooled()
      else -> throw TextPipelineException(
        TextErrorCodes.INVALID_ARGUMENT,
        "Unknown mode: $mode. Use 'fullIfSpooled' or 'windowSnapshot'."
      )
    }

    val entry = OfflineTextEntry(
      bufferId = bufferId,
      text = text,
      populated = text.isNotEmpty()
    )
    offlineEntries[bufferId] = entry
    return entry
  }

  // ==================== Live Buffer Creation ====================

  private fun defaultSpoolPath(): String {
    val dir = cacheDir ?: File(System.getProperty("java.io.tmpdir") ?: ".")
    return File(dir, "txt_spool_${UUID.randomUUID()}.bin").absolutePath
  }

  /**
   * Create a new live text buffer.
   */
  fun createLive(
    windowMaxChars: Int = 65536,
    maxSegments: Int = 4096,
    emitPartialEvents: Boolean = false,
    partialEventMinIntervalMs: Long = 0,
    spoolingMode: TextSpoolingMode = TextSpoolingMode.ON,
    spoolingPath: String? = null,
    spoolingTemporary: Boolean? = null,
    spoolingThresholdBytes: Long = 0,
  ): LiveTextEntry {
    val bufferId = "txt_live_${UUID.randomUUID()}"

    val resolvedSpoolPath = if (spoolingMode == TextSpoolingMode.OFF) {
      null
    } else {
      spoolingPath ?: defaultSpoolPath()
    }

    val resolvedTemporary = spoolingTemporary ?: spoolingPath.isNullOrEmpty()

    val entry = LiveTextEntry(
      bufferId = bufferId,
      windowMaxChars = windowMaxChars,
      maxSegments = maxSegments,
      emitPartialEvents = emitPartialEvents,
      partialEventMinIntervalMs = partialEventMinIntervalMs,
      spoolingMode = spoolingMode,
      spoolPath = resolvedSpoolPath,
      spoolTemporary = resolvedTemporary,
      spoolThresholdBytes = spoolingThresholdBytes,
    )
    liveEntries[bufferId] = entry
    return entry
  }

  /**
   * Create a live text buffer seeded from an offline text buffer.
   * Uses default live spooling config (mode=on).
   */
  fun createLiveFromOffline(offlineBufferId: String): LiveTextEntry {
    val offline = offlineEntries[offlineBufferId]
      ?: throw IllegalArgumentException("Offline text buffer not found: $offlineBufferId")

    val entry = createLive()
    if (offline.text.isNotEmpty()) {
      entry.writePartial(offline.text)
    }
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
    val offlineRemoved = offlineEntries.remove(bufferId) != null

    val liveRemoved = liveEntries.remove(bufferId)?.let {
      try {
        it.release()
      } catch (_: Exception) {
        // best-effort cleanup
      }
      true
    } ?: false

    return offlineRemoved || liveRemoved
  }

  /**
   * Release all text buffers. For cleanup on module invalidate.
   */
  fun releaseAll() {
    liveEntries.values.forEach {
      try {
        it.release()
      } catch (_: Exception) {
        // best-effort cleanup
      }
    }
    offlineEntries.clear()
    liveEntries.clear()
  }
}
