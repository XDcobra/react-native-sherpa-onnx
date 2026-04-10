package com.sherpaonnx.audio.pipeline

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableMap
import com.k2fsa.sherpa.onnx.WaveReader
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Unified pipeline audio buffer registry.
 *
 * Manages both OfflineEntry (immutable PCM) and LiveEntry (streaming PCM with ring buffer).
 * Thread-safe via ConcurrentHashMap. Buffer IDs are prefixed for runtime type checking:
 * - `off_…` for OfflineEntry
 * - `live_…` for LiveEntry
 */
object PipelineAudioRegistry {

  /** Threshold in bytes: files larger than this are file-backed instead of loaded into RAM. */
  private const val FILE_BACKED_THRESHOLD_BYTES = 10L * 1024 * 1024 // 10 MB

  private val offlineEntries = ConcurrentHashMap<String, OfflineEntry>()
  private val liveEntries = ConcurrentHashMap<String, LiveEntry>()

  // ==================== Offline Buffer Creation ====================

  /**
   * Create an offline buffer from a WAV file.
   * Small files (< threshold) are loaded into memory; large files remain file-backed.
   *
   * @param filePath Absolute path to WAV file.
   * @param targetSampleRateHz Target sample rate. If null, uses the file's native rate.
   * @param forceMono If true, force mono output. Currently only mono is supported.
   */
  fun createOfflineFromFile(
    filePath: String,
    targetSampleRateHz: Int? = null,
    forceMono: Boolean? = null
  ): OfflineEntry {
    val file = File(filePath)
    if (!file.exists()) throw IllegalArgumentException("Audio file does not exist: $filePath")
    if (file.length() == 0L) throw IllegalArgumentException("Audio file is empty: $filePath")
    if (targetSampleRateHz != null && targetSampleRateHz <= 0) {
      throw IllegalArgumentException("targetSampleRateHz must be > 0, got: $targetSampleRateHz")
    }

    val bufferId = "off_${UUID.randomUUID()}"

    // Try file-backed first for large files
    if (file.length() > FILE_BACKED_THRESHOLD_BYTES && targetSampleRateHz == null) {
      val metadata = parseWavHeader(filePath)
      if (metadata != null) {
        val entry = OfflineEntry.FileBacked(
          bufferId = bufferId,
          sampleRate = metadata.sampleRate,
          channelCount = metadata.channelCount,
          filePath = filePath,
          metadata = metadata
        )
        offlineEntries[bufferId] = entry
        return entry
      }
      // Fall through to WaveReader if header parsing fails
    }

    // In-memory path: load via WaveReader (handles more formats, resamples if needed)
    val wave = WaveReader.readWave(filePath)
    val sourceSamples = wave.samples ?: FloatArray(0)
    if (sourceSamples.isEmpty()) {
      throw IllegalArgumentException("Could not read audio samples from: $filePath")
    }

    val outputSampleRate = targetSampleRateHz ?: wave.sampleRate
    val outputSamples = if (outputSampleRate != wave.sampleRate) {
      Resampler.resampleLinear(sourceSamples, wave.sampleRate, outputSampleRate)
    } else {
      sourceSamples
    }

    val entry = OfflineEntry.InMemory(
      bufferId = bufferId,
      sampleRate = outputSampleRate,
      channelCount = 1, // WaveReader always returns mono
      samples = outputSamples
    )
    offlineEntries[bufferId] = entry
    return entry
  }

  /**
   * Create an offline buffer from Float32 PCM samples provided from JS.
   * Always in-memory.
   */
  fun createOfflineFromSamples(
    samples: FloatArray,
    sampleRate: Int,
    channelCount: Int = 1
  ): OfflineEntry {
    if (sampleRate <= 0) throw IllegalArgumentException("sampleRate must be > 0")
    if (samples.isEmpty()) throw IllegalArgumentException("samples must not be empty")
    if (channelCount != 1) throw IllegalArgumentException("Only mono (channelCount=1) is supported")

    val bufferId = "off_${UUID.randomUUID()}"
    val entry = OfflineEntry.InMemory(
      bufferId = bufferId,
      sampleRate = sampleRate,
      channelCount = channelCount,
      samples = samples
    )
    offlineEntries[bufferId] = entry
    return entry
  }

  /**
   * Create an offline buffer from a live buffer.
   *
   * @param liveBufferId ID of the live buffer.
   * @param mode How to create the offline buffer:
   *   - "fullIfSpooled": If live has a spool file, create file-backed offline from it
   *     (no RAM duplication). Otherwise, snapshot the ring.
   *   - "windowSnapshot": Always snapshot the current ring window (in-memory copy).
   */
  fun createOfflineFromLive(
    liveBufferId: String,
    mode: String = "fullIfSpooled"
  ): OfflineEntry {
    val live = liveEntries[liveBufferId]
      ?: throw IllegalArgumentException("Live buffer not found: $liveBufferId")

    val bufferId = "off_${UUID.randomUUID()}"

    return when (mode) {
      "fullIfSpooled" -> {
        val spoolPath = live.spoolFilePath
        if (spoolPath != null && live.state == LiveEntry.State.FINISHED) {
          // File-backed from finalized spool (no RAM duplication)
          val metadata = parseWavHeader(spoolPath)
          if (metadata != null) {
            val entry = OfflineEntry.FileBacked(
              bufferId = bufferId,
              sampleRate = metadata.sampleRate,
              channelCount = metadata.channelCount,
              filePath = spoolPath,
              metadata = metadata
            )
            offlineEntries[bufferId] = entry
            entry
          } else {
            // Spool header unreadable, fall back to ring snapshot
            createFromRingSnapshot(bufferId, live)
          }
        } else {
          // No spool or still recording: snapshot ring
          createFromRingSnapshot(bufferId, live)
        }
      }
      "windowSnapshot" -> createFromRingSnapshot(bufferId, live)
      else -> throw IllegalArgumentException("Unknown mode: $mode. Use 'fullIfSpooled' or 'windowSnapshot'.")
    }
  }

  private fun createFromRingSnapshot(bufferId: String, live: LiveEntry): OfflineEntry {
    val snapshot = live.snapshotRing()
    val entry = OfflineEntry.InMemory(
      bufferId = bufferId,
      sampleRate = live.sampleRate,
      channelCount = live.channelCount,
      samples = snapshot
    )
    offlineEntries[bufferId] = entry
    return entry
  }

  // ==================== Live Buffer Creation ====================

  /**
   * Create a new live audio buffer.
   *
   * @param sampleRate Sample rate for this buffer.
   * @param windowSeconds Ring buffer window size in seconds (default: 60).
   * @param persistence Optional persistence config for spool-to-disk.
   */
  fun createLive(
    sampleRate: Int,
    channelCount: Int = 1,
    windowSeconds: Double = 60.0,
    persistence: PersistenceConfig? = null,
    appendEventConfig: LiveAppendEventConfig = LiveAppendEventConfig(),
    onFramesAppended: ((LiveFramesAppendedEvent) -> Unit)? = null,
  ): LiveEntry {
    if (sampleRate <= 0) throw IllegalArgumentException("sampleRate must be > 0")
    if (channelCount != 1) throw IllegalArgumentException("Only mono (channelCount=1) is supported")
    if (windowSeconds <= 0) throw IllegalArgumentException("windowSeconds must be > 0")

    val bufferId = "live_${UUID.randomUUID()}"
    val entry = LiveEntry(
      bufferId = bufferId,
      sampleRate = sampleRate,
      channelCount = channelCount,
      windowSeconds = windowSeconds,
      persistence = persistence,
      appendEventConfig = appendEventConfig,
      onFramesAppended = onFramesAppended,
    )
    liveEntries[bufferId] = entry
    return entry
  }

  // ==================== Append to Live Buffer ====================

  /**
   * Append Float32 samples to a live buffer.
   * @param liveBufferId Live buffer ID.
   * @param samples Float32 samples [-1, 1].
   * @param sampleRate Sample rate of the incoming samples.
   */
  fun appendSamplesToLive(
    liveBufferId: String,
    samples: FloatArray,
    sampleRate: Int,
    source: String = LIVE_APPEND_SOURCE_APPEND,
  ) {
    val entry = liveEntries[liveBufferId]
      ?: throw IllegalArgumentException("Live buffer not found: $liveBufferId")
    if (entry.state != LiveEntry.State.RECORDING) {
      throw IllegalStateException("Live buffer is finalized, cannot append")
    }
    entry.appendSamples(samples, sampleRate, source)
  }

  /**
   * Append all samples from an offline buffer to a live buffer.
   */
  fun appendOfflineToLive(liveBufferId: String, offlineBufferId: String) {
    val live = liveEntries[liveBufferId]
      ?: throw IllegalArgumentException("Live buffer not found: $liveBufferId")
    if (live.state != LiveEntry.State.RECORDING) {
      throw IllegalStateException("Live buffer is finalized, cannot append")
    }
    val offline = offlineEntries[offlineBufferId]
      ?: throw IllegalArgumentException("Offline buffer not found: $offlineBufferId")

    // Stream from offline to avoid full-RAM copy for file-backed entries
    offline.createReader().use { reader ->
      val chunk = FloatArray(8192)
      while (true) {
        val read = reader.readSamples(chunk, 0, chunk.size)
        if (read <= 0) break
        val toAppend = if (read == chunk.size) chunk else chunk.copyOf(read)
        live.appendSamples(toAppend, offline.sampleRate, LIVE_APPEND_SOURCE_APPEND_OFFLINE)
      }
    }
  }

  fun configureLiveAppendEvents(
    liveBufferId: String,
    enabled: Boolean? = null,
    includeSamples: Boolean? = null,
    minIntervalMs: Int? = null,
  ) {
    val entry = liveEntries[liveBufferId]
      ?: throw IllegalArgumentException("Live buffer not found: $liveBufferId")
    entry.configureAppendEvents(enabled, includeSamples, minIntervalMs)
  }

  fun setLiveFramesAppendedListener(
    liveBufferId: String,
    listener: ((LiveFramesAppendedEvent) -> Unit)?,
  ) {
    val entry = liveEntries[liveBufferId]
      ?: throw IllegalArgumentException("Live buffer not found: $liveBufferId")
    entry.setOnFramesAppendedListener(listener)
  }

  // ==================== Finalize Live Buffer ====================

  fun finalizeLive(liveBufferId: String) {
    val entry = liveEntries[liveBufferId]
      ?: throw IllegalArgumentException("Live buffer not found: $liveBufferId")
    entry.finalize_()
  }

  // ==================== Info / Release ====================

  /**
   * Get info for any buffer (offline or live).
   */
  fun getInfo(bufferId: String): WritableMap {
    offlineEntries[bufferId]?.let { return it.toWritableMap() }
    liveEntries[bufferId]?.let { return it.toWritableMap() }
    throw IllegalArgumentException("Buffer not found: $bufferId")
  }

  /**
   * Release any buffer (offline or live).
   */
  fun release(bufferId: String): Boolean {
    offlineEntries.remove(bufferId)?.let { return true }
    liveEntries.remove(bufferId)?.let {
      it.release()
      return true
    }
    return false
  }

  // ==================== Save ====================

  fun saveOfflineToWav(bufferId: String, outputPath: String) {
    val entry = offlineEntries[bufferId]
      ?: throw IllegalArgumentException("Offline buffer not found: $bufferId")
    entry.saveToWav(outputPath)
  }

  fun saveLiveToWav(bufferId: String, outputPath: String) {
    val entry = liveEntries[bufferId]
      ?: throw IllegalArgumentException("Live buffer not found: $bufferId")
    entry.saveToWav(outputPath)
  }

  // ==================== Accessors for pipeline stages ====================

  fun getOffline(bufferId: String): OfflineEntry? = offlineEntries[bufferId]
  fun getLive(bufferId: String): LiveEntry? = liveEntries[bufferId]

  /** Check whether a buffer ID refers to an offline entry. */
  fun isOffline(bufferId: String): Boolean = offlineEntries.containsKey(bufferId)

  /** Check whether a buffer ID refers to a live entry. */
  fun isLive(bufferId: String): Boolean = liveEntries.containsKey(bufferId)

  // ==================== JS Sample Slice (for debug/export) ====================

  /**
   * Get a slice of samples from a live buffer's ring for JS consumption.
   */
  fun getLiveSamplesSlice(liveBufferId: String, startFrame: Int, frameCount: Int): FloatArray {
    val entry = liveEntries[liveBufferId]
      ?: throw IllegalArgumentException("Live buffer not found: $liveBufferId")
    return entry.getSamplesSlice(startFrame, frameCount)
  }

  // ==================== Cursor management (for native pipeline stages) ====================

  fun createLiveCursor(liveBufferId: String): Int {
    val entry = liveEntries[liveBufferId]
      ?: throw IllegalArgumentException("Live buffer not found: $liveBufferId")
    return entry.createCursorHandle()
  }

  fun peekLiveCursor(liveBufferId: String, cursorId: Int, maxSamples: Int): FloatArray {
    val entry = liveEntries[liveBufferId]
      ?: throw IllegalArgumentException("Live buffer not found: $liveBufferId")
    return entry.peekCursor(cursorId, maxSamples)
  }

  fun drainLiveCursor(liveBufferId: String, cursorId: Int, maxSamples: Int): FloatArray {
    val entry = liveEntries[liveBufferId]
      ?: throw IllegalArgumentException("Live buffer not found: $liveBufferId")
    return entry.drainCursor(cursorId, maxSamples)
  }

  fun releaseLiveCursor(liveBufferId: String, cursorId: Int) {
    val entry = liveEntries[liveBufferId]
      ?: throw IllegalArgumentException("Live buffer not found: $liveBufferId")
    entry.releaseCursor(cursorId)
  }

  // ==================== Utility ====================

  fun clear() {
    liveEntries.values.forEach { it.release() }
    liveEntries.clear()
    offlineEntries.clear()
  }

  /** Helper: convert ReadableArray of doubles to FloatArray. */
  fun readableArrayToFloatArray(arr: ReadableArray): FloatArray {
    val size = arr.size()
    val out = FloatArray(size)
    for (i in 0 until size) {
      out[i] = arr.getDouble(i).toFloat()
    }
    return out
  }
}
