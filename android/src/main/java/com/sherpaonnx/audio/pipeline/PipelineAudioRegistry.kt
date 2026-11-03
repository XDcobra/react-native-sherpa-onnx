package com.sherpaonnx.audio.pipeline

import android.content.Context
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.sherpaonnx.SherpaOnnxNativeLoader
import java.io.File
import java.util.concurrent.ConcurrentHashMap

private const val TAG = "PipelineAudioRegistry"

/**
 * Facade over shared C++ AudioRegistry.
 * Kotlin maps hold handles (listeners / type aliases) only — PCM SoT is in C++.
 */
object PipelineAudioRegistry {
  init {
    SherpaOnnxNativeLoader.ensureLoaded()
  }

  private val offlineEntries = ConcurrentHashMap<String, OfflineEntry>()
  private val liveEntries = ConcurrentHashMap<String, LiveEntry>()

  @Volatile
  var cacheDir: File? = null

  fun initializeWithCacheDir(context: Context, dir: File) {
    cacheDir = dir
    val ram =
      try {
        val act = context.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
        val info = android.app.ActivityManager.MemoryInfo()
        act.getMemoryInfo(info)
        info.totalMem
      } catch (_: Exception) {
        6L * 1024L * 1024L * 1024L
      }
    AudioBufferNative.nativeInit(dir.absolutePath, ram)
    try {
      MmapThresholdPolicy.initialize(context.applicationContext)
    } catch (_: Exception) {
      // optional Kotlin helper; C threshold already configured via nativeInit
    }
  }

  fun createOfflineFromFloatArray(
    samples: FloatArray,
    sampleRate: Int,
    channelCount: Int = 1,
  ): OfflineEntry {
    require(sampleRate > 0)
    require(samples.isNotEmpty())
    require(channelCount == 1)
    val id =
      AudioBufferNative.nativeCreateOfflineFromSamples(samples, sampleRate, channelCount)
        ?: throw IllegalStateException("Failed to create offline buffer")
    val entry = OfflineEntry.wrap(id) ?: OfflineEntry.InMemory(id, sampleRate, channelCount)
    offlineEntries[id] = entry
    return entry
  }

  fun createOfflineFromMmapFile(
    f32FilePath: String,
    numSamples: Int,
    sampleRate: Int,
    channelCount: Int = 1,
  ): OfflineEntry {
    require(sampleRate > 0)
    require(numSamples > 0)
    val id =
      AudioBufferNative.nativeCreateOfflineFromF32File(f32FilePath, sampleRate, channelCount)
        ?: throw IllegalStateException("Failed to mmap offline f32")
    val entry = OfflineEntry.MmapBacked(id, sampleRate, channelCount, f32FilePath)
    offlineEntries[id] = entry
    return entry
  }

  fun createEmptyOffline(sampleRate: Int, channelCount: Int = 1): OfflineEntry {
    require(sampleRate > 0)
    require(channelCount == 1)
    val id =
      AudioBufferNative.nativeCreateEmptyOffline(sampleRate, channelCount)
        ?: throw IllegalStateException("Failed to create empty offline")
    val entry = OfflineEntry.InMemory(id, sampleRate, channelCount)
    offlineEntries[id] = entry
    return entry
  }

  fun replaceOfflineEntry(bufferId: String, entry: OfflineEntry) {
    if (entry.bufferId != bufferId) {
      AudioBufferNative.nativeRelease(bufferId)
      offlineEntries.remove(bufferId)
    }
    offlineEntries[entry.bufferId] = entry
  }

  fun createOfflineFromLive(
    liveBufferId: String,
    mode: String = "fullIfSpooled",
    targetSampleRateHz: Int? = null,
  ): OfflineEntry {
    if (mode != "fullIfSpooled" && mode != "windowSnapshot") {
      throw IllegalArgumentException(
        "Unknown mode: $mode. Use 'fullIfSpooled' or 'windowSnapshot'."
      )
    }
    val live =
      getLive(liveBufferId)
        ?: if (isInvalidatedLiveBuffer(liveBufferId)) {
          throw BufferInvalidatedException(
            "Live buffer was transferred and is invalidated: $liveBufferId",
          )
        } else {
          throw IllegalArgumentException("Live buffer not found: $liveBufferId")
        }

    val fullIfSpooled = mode == "fullIfSpooled"
    // windowSnapshot: copy ring without invalidating live; fullIfSpooled: transfer via C.
    val entry =
      if (mode == "windowSnapshot") {
        val snap = live.snapshotRing()
        createOfflineFromFloatArray(snap, live.sampleRate, live.channelCount)
      } else {
        val id =
          AudioBufferNative.nativeTransferFromLive(liveBufferId, fullIfSpooled)
            ?: throw IllegalStateException("transfer from live failed")
        liveEntries.remove(liveBufferId)
        OfflineEntry.wrap(id) ?: throw IllegalStateException("offline missing after transfer")
      }
    offlineEntries[entry.bufferId] = entry

    val effectiveTarget = resolveEffectiveTargetSampleRateHz(targetSampleRateHz, entry.sampleRate)
    if (effectiveTarget == entry.sampleRate) return entry
    return resampleOfflineEntry(entry, effectiveTarget)
  }

  fun transferOfflineFromLive(
    liveBufferId: String,
    mode: String = "fullIfSpooled",
  ): OfflineEntry {
    if (mode != "fullIfSpooled") {
      throw TransferException(
        PipelineAudioErrorCodes.INVALID_ARGUMENT,
        "Unsupported transfer mode: $mode. Use 'fullIfSpooled'.",
      )
    }
    if (getLive(liveBufferId) == null) {
      if (isInvalidatedLiveBuffer(liveBufferId)) {
        throw TransferException(
          PipelineAudioErrorCodes.BUFFER_INVALIDATED,
          "Live buffer was transferred and is invalidated: $liveBufferId",
        )
      }
      throw TransferException(
        PipelineAudioErrorCodes.BUFFER_NOT_FOUND,
        "Live buffer not found: $liveBufferId",
      )
    }
    return try {
      createOfflineFromLive(liveBufferId, mode, null)
    } catch (e: BufferInvalidatedException) {
      throw TransferException(PipelineAudioErrorCodes.BUFFER_INVALIDATED, e.message ?: "")
    } catch (e: IllegalArgumentException) {
      throw TransferException(PipelineAudioErrorCodes.INVALID_ARGUMENT, e.message ?: "")
    } catch (e: IllegalStateException) {
      throw TransferException(PipelineAudioErrorCodes.INVALID_STATE, e.message ?: "")
    }
  }

  fun createOfflineFromOffline(
    sourceBufferId: String,
    targetSampleRateHz: Int? = null,
  ): OfflineEntry {
    val source =
      getOffline(sourceBufferId)
        ?: throw IllegalArgumentException("Offline buffer not found: $sourceBufferId")
    val effectiveTarget = resolveEffectiveTargetSampleRateHz(targetSampleRateHz, source.sampleRate)
    if (effectiveTarget == source.sampleRate) {
      return createOfflineFromFloatArray(
        source.readAllSamples(),
        source.sampleRate,
        source.channelCount,
      )
    }
    if (source.channelCount != 1) {
      throw IllegalArgumentException(
        "Resampling offline→offline requires mono (channelCount=1), got ${source.channelCount}",
      )
    }
    return resampleOfflineEntry(source, effectiveTarget)
  }

  private fun resolveEffectiveTargetSampleRateHz(target: Int?, sourceRate: Int): Int {
    if (target == null || target <= 0) return sourceRate
    return target
  }

  private fun resampleOfflineEntry(source: OfflineEntry, targetRate: Int): OfflineEntry {
    val samples = source.readAllSamples()
    val resampled = Resampler.resampleLinear(samples, source.sampleRate, targetRate)
    // Release intermediate transfer result if it was a distinct buffer we just created.
    if (source.bufferId != samples.hashCode().toString()) {
      // keep source registered; caller owns lifecycle of createOfflineFromLive transfer target
    }
    return createOfflineFromFloatArray(resampled, targetRate, source.channelCount)
  }

  fun populateOfflineIfEmpty(targetBufferId: String, sourceBufferId: String) {
    val source =
      getOffline(sourceBufferId) ?: throw IllegalArgumentException("source not found")
    val target =
      getOffline(targetBufferId) ?: throw IllegalArgumentException("target not found")
    if (target.numSamples > 0) {
      throw IllegalStateException("target not empty")
    }
    val ok = AudioBufferNative.nativeAdoptIfEmpty(targetBufferId, source.readAllSamples())
    if (!ok) throw IllegalStateException("adopt failed")
  }

  fun upgradeToMmapIfNeeded(bufferId: String) {
    AudioBufferNative.nativeUpgradeToMmap(bufferId)
    val existing = offlineEntries[bufferId]
    if (existing is OfflineEntry.InMemory) {
      val path = AudioBufferNative.nativeOfflineFilePath(bufferId) ?: ""
      offlineEntries[bufferId] =
        OfflineEntry.MmapBacked(bufferId, existing.sampleRate, existing.channelCount, path)
    }
  }

  fun createLive(
    sampleRate: Int,
    channelCount: Int = 1,
    windowSeconds: Double = 60.0,
    persistence: PersistenceConfig? = null,
    appendEventConfig: LiveAppendEventConfig = LiveAppendEventConfig(),
    onFramesAppended: ((LiveFramesAppendedEvent) -> Unit)? = null,
    isTemporarySpool: Boolean = false,
  ): LiveEntry {
    require(sampleRate > 0) { "sampleRate must be > 0" }
    require(channelCount == 1) { "Only mono (channelCount=1) is supported" }
    require(windowSeconds > 0) { "windowSeconds must be > 0" }

    val spoolPath = persistence?.filePath
    val id =
      AudioBufferNative.nativeCreateLive(
        sampleRate,
        channelCount,
        windowSeconds,
        spoolPath,
        appendEventConfig.enabled,
        appendEventConfig.minIntervalMs,
      ) ?: throw IllegalStateException("Failed to create live buffer")

    val entry =
      LiveEntry(
        bufferId = id,
        sampleRate = sampleRate,
        channelCount = channelCount,
        windowSeconds = windowSeconds,
        persistence = persistence,
        appendEventConfig = appendEventConfig,
        onFramesAppended = onFramesAppended,
        isTemporarySpool = isTemporarySpool,
      )
    liveEntries[id] = entry
    return entry
  }

  fun appendSamplesToLive(
    liveBufferId: String,
    samples: FloatArray,
    sampleRate: Int,
    origin: LiveAppendOrigin = LiveAppendOrigin.Ingress(LiveAudioIngressSource.APPEND),
  ) {
    val entry = requireLiveEntry(liveBufferId)
    if (entry.state != LiveEntry.State.RECORDING) {
      throw IllegalStateException("Live buffer is finalized, cannot append")
    }
    entry.appendSamples(samples, sampleRate, origin)
  }

  fun appendOfflineToLive(liveBufferId: String, offlineBufferId: String) {
    val live = requireLiveEntry(liveBufferId)
    if (live.state != LiveEntry.State.RECORDING) {
      throw IllegalStateException("Live buffer is finalized, cannot append")
    }
    val offline =
      getOffline(offlineBufferId)
        ?: throw IllegalArgumentException("Offline buffer not found: $offlineBufferId")
    offline.createReader().use { reader ->
      val chunk = FloatArray(8192)
      while (true) {
        val read = reader.readSamples(chunk, 0, chunk.size)
        if (read <= 0) break
        val toAppend = if (read == chunk.size) chunk else chunk.copyOf(read)
        live.appendSamples(
          toAppend,
          offline.sampleRate,
          LiveAppendOrigin.Ingress(LiveAudioIngressSource.APPEND_OFFLINE),
        )
      }
    }
  }

  fun configureLiveAppendEvents(
    liveBufferId: String,
    enabled: Boolean? = null,
    minIntervalMs: Int? = null,
  ) {
    requireLiveEntry(liveBufferId).configureAppendEvents(enabled, minIntervalMs)
  }

  fun setLiveFramesAppendedListener(
    liveBufferId: String,
    listener: ((LiveFramesAppendedEvent) -> Unit)?,
  ) {
    requireLiveEntry(liveBufferId).setOnFramesAppendedListener(listener)
  }

  fun finalizeLive(liveBufferId: String) {
    requireLiveEntry(liveBufferId).finalize_()
  }

  fun getInfo(bufferId: String): WritableMap {
    getOffline(bufferId)?.let {
      return it.toWritableMap()
    }
    getLive(bufferId)?.let {
      return it.toWritableMap()
    }
    throw IllegalArgumentException("AUDIO_BUFFER_NOT_FOUND: $bufferId")
  }

  fun release(bufferId: String): Boolean {
    offlineEntries.remove(bufferId)
    liveEntries.remove(bufferId)
    return AudioBufferNative.nativeRelease(bufferId)
  }

  fun getOffline(bufferId: String): OfflineEntry? {
    offlineEntries[bufferId]?.let { return it }
    val wrapped = OfflineEntry.wrap(bufferId) ?: return null
    offlineEntries[bufferId] = wrapped
    return wrapped
  }

  fun getLive(bufferId: String): LiveEntry? {
    liveEntries[bufferId]?.let { return it }
    val wrapped = LiveEntry.wrap(bufferId) ?: return null
    liveEntries[bufferId] = wrapped
    return wrapped
  }

  fun isInvalidatedLiveBuffer(bufferId: String): Boolean =
    AudioBufferNative.nativeIsInvalidatedLive(bufferId)

  fun isOffline(bufferId: String): Boolean = AudioBufferNative.nativeIsOffline(bufferId)

  fun isLive(bufferId: String): Boolean = AudioBufferNative.nativeIsLive(bufferId)

  fun getLiveSamplesSlice(liveBufferId: String, startFrame: Int, frameCount: Int): FloatArray =
    AudioBufferNative.nativeReadLiveSlice(liveBufferId, startFrame, frameCount) ?: FloatArray(0)

  fun getOfflineSamplesSliceJni(
    bufferId: String,
    startFrame: Int,
    frameCount: Int,
  ): FloatArray =
    AudioBufferNative.nativeReadOfflineSlice(bufferId, startFrame, frameCount) ?: FloatArray(0)

  fun getLiveSamplesSliceJni(
    bufferId: String,
    startFrame: Int,
    frameCount: Int,
  ): FloatArray = getLiveSamplesSlice(bufferId, startFrame, frameCount)

  fun createOfflineFromFloatArrayJni(
    samples: FloatArray,
    sampleRate: Int,
    channelCount: Int,
  ): String = createOfflineFromFloatArray(samples, sampleRate, channelCount).bufferId

  fun appendSamplesToLiveJni(
    bufferId: String,
    samples: FloatArray,
    sampleRate: Int,
  ) {
    appendSamplesToLive(bufferId, samples, sampleRate)
  }

  fun createLiveCursor(liveBufferId: String): Int = AudioBufferNative.nativeCreateCursor(liveBufferId)

  fun peekLiveCursor(liveBufferId: String, cursorId: Int, maxSamples: Int): FloatArray =
    AudioBufferNative.nativePeekCursor(liveBufferId, cursorId, maxSamples) ?: FloatArray(0)

  fun drainLiveCursor(liveBufferId: String, cursorId: Int, maxSamples: Int): FloatArray =
    AudioBufferNative.nativeDrainCursor(liveBufferId, cursorId, maxSamples) ?: FloatArray(0)

  fun releaseLiveCursor(liveBufferId: String, cursorId: Int) {
    AudioBufferNative.nativeReleaseCursor(liveBufferId, cursorId)
  }

  fun clear() {
    for (id in offlineEntries.keys.toList()) {
      release(id)
    }
    for (id in liveEntries.keys.toList()) {
      release(id)
    }
  }

  private fun requireLiveEntry(liveBufferId: String): LiveEntry =
    getLive(liveBufferId)
      ?: throw IllegalArgumentException("Live buffer not found: $liveBufferId")
}

class TransferException(
  val code: String,
  message: String,
) : RuntimeException(message)

class BufferInvalidatedException(
  message: String,
) : RuntimeException(message)
