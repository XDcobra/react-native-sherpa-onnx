package com.sherpaonnx.text.pipeline

import com.sherpaonnx.SherpaOnnxNativeLoader
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * Facade over shared C++ TextRegistry.
 * Handle maps keep Kotlin listeners; text/spool SoT is in C++.
 */
object TextPipelineRegistry {
  init {
    SherpaOnnxNativeLoader.ensureLoaded()
  }

  private val offlineEntries = ConcurrentHashMap<String, OfflineTextEntry>()
  private val liveEntries = ConcurrentHashMap<String, LiveTextEntry>()

  @Volatile
  private var cacheDir: File? = null

  @Volatile
  var liveTextPartialEmitter: ((LiveTextEntry, String) -> Unit)? = null

  internal fun notifyLivePartialWritten(entry: LiveTextEntry, source: String) {
    liveTextPartialEmitter?.invoke(entry, source)
  }

  fun initializeWithCacheDir(dir: File) {
    cacheDir = dir
    TextBufferNative.nativeInit(dir.absolutePath)
  }

  fun createEmptyOffline(): OfflineTextEntry {
    val id =
      TextBufferNative.nativeCreateEmptyOffline()
        ?: throw IllegalStateException("Failed to create empty offline text buffer")
    val entry = OfflineTextEntry(bufferId = id)
    offlineEntries[id] = entry
    return entry
  }

  fun createOfflineFromText(
    text: String,
    lang: String = "",
    emotion: String = "",
    event: String = "",
  ): OfflineTextEntry {
    val id =
      TextBufferNative.nativeCreateOfflineFromText(text, lang, emotion, event)
        ?: throw IllegalStateException("Failed to create offline text buffer")
    val entry = OfflineTextEntry(bufferId = id)
    offlineEntries[id] = entry
    return entry
  }

  fun createOfflineFromLive(liveBufferId: String, mode: String = "fullIfSpooled"): OfflineTextEntry {
    val id =
      TextBufferNative.nativeCreateOfflineFromLive(liveBufferId, mode)
        ?: throw TextPipelineException(
          TextErrorCodes.INVALID_ARGUMENT,
          "createOfflineFromLive failed for $liveBufferId mode=$mode",
        )
    val entry = OfflineTextEntry.wrap(id) ?: OfflineTextEntry(bufferId = id)
    offlineEntries[id] = entry
    return entry
  }

  private fun defaultSpoolPath(): String {
    val dir = cacheDir ?: File(System.getProperty("java.io.tmpdir") ?: ".")
    return File(dir, "txt_spool_${System.nanoTime()}.bin").absolutePath
  }

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
    @Suppress("UNUSED_VARIABLE")
    val unusedThreshold = spoolingThresholdBytes
    val resolvedSpoolPath =
      if (spoolingMode == TextSpoolingMode.OFF) null else (spoolingPath ?: defaultSpoolPath())
    val resolvedTemporary = spoolingTemporary ?: spoolingPath.isNullOrEmpty()
    val id =
      TextBufferNative.nativeCreateLive(
        windowMaxChars,
        maxSegments,
        emitPartialEvents,
        partialEventMinIntervalMs,
        spoolingMode.rawValue(),
        resolvedSpoolPath,
        resolvedTemporary,
      ) ?: throw IllegalStateException("Failed to create live text buffer")
    val entry =
      LiveTextEntry(
        bufferId = id,
        windowMaxChars = windowMaxChars,
        maxSegments = maxSegments,
        emitPartialEvents = emitPartialEvents,
        partialEventMinIntervalMs = partialEventMinIntervalMs,
        spoolingMode = spoolingMode,
        spoolPath = resolvedSpoolPath,
        spoolTemporary = resolvedTemporary,
        spoolThresholdBytes = spoolingThresholdBytes,
      )
    liveEntries[id] = entry
    return entry
  }

  fun createLiveFromOffline(offlineBufferId: String): LiveTextEntry {
    val offline =
      getOffline(offlineBufferId)
        ?: throw IllegalArgumentException("Offline text buffer not found: $offlineBufferId")
    val entry = createLive()
    if (offline.text.isNotEmpty()) {
      entry.writePartial(offline.text)
    }
    return entry
  }

  fun getOffline(bufferId: String): OfflineTextEntry? {
    offlineEntries[bufferId]?.let { return it }
    val wrapped = OfflineTextEntry.wrap(bufferId) ?: return null
    offlineEntries[bufferId] = wrapped
    return wrapped
  }

  fun getLive(bufferId: String): LiveTextEntry? {
    liveEntries[bufferId]?.let { return it }
    val wrapped = LiveTextEntry.wrap(bufferId) ?: return null
    liveEntries[bufferId] = wrapped
    return wrapped
  }

  fun release(bufferId: String): Boolean {
    offlineEntries.remove(bufferId)
    liveEntries.remove(bufferId)?.let {
      try {
        it.release()
      } catch (_: Exception) {
      }
      return true
    }
    return TextBufferNative.nativeRelease(bufferId)
  }

  fun releaseAll() {
    for (id in liveEntries.keys.toList()) {
      release(id)
    }
    for (id in offlineEntries.keys.toList()) {
      release(id)
    }
    TextBufferNative // ensure class loaded
  }
}
