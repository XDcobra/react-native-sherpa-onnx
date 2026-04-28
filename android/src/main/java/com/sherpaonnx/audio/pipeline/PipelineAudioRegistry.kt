package com.sherpaonnx.audio.pipeline

import android.content.Context
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import java.io.Closeable
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

private const val TAG = "PipelineAudioRegistry"

/**
 * Unified pipeline audio buffer registry.
 *
 * Manages both OfflineEntry (immutable PCM) and LiveEntry (streaming PCM with ring buffer).
 * Thread-safe via ConcurrentHashMap. Buffer IDs are prefixed for runtime type checking:
 * - `off_…` for OfflineEntry
 * - `live_…` for LiveEntry
 */
object PipelineAudioRegistry {

  private val offlineEntries = ConcurrentHashMap<String, OfflineEntry>()
  private val liveEntries = ConcurrentHashMap<String, LiveEntry>()
  private val invalidatedLiveIds = ConcurrentHashMap.newKeySet<String>()

  /** Set once during module init — used for mmap temp files. */
  @Volatile
  var cacheDir: File? = null

  /**
   * Run startup orphan sweep. Call once from module initialize().
   */
  fun initializeWithCacheDir(context: Context, dir: File) {
    cacheDir = dir
    MmapThresholdPolicy.initialize(context.applicationContext)
    OfflineEntry.sweepOrphanedTempFiles(dir)
    OfflineEntry.cleanupOrphanedOrchestrationFiles(dir)
  }

  // ==================== Offline Buffer Creation ====================

  /**
   * Create an offline buffer from Float32 PCM samples (in-memory FloatArray).
   * Uses mmap for large buffers, in-memory for small ones.
   *
   * WARNING: For large FloatArrays, this may cause OOM. Prefer file-based APIs
   * (decodeFileToOfflineBuffer, createOfflineFromLive with spool files) for big data.
   */
  fun createOfflineFromFloatArray(
    samples: FloatArray,
    sampleRate: Int,
    channelCount: Int = 1
  ): OfflineEntry {
    if (sampleRate <= 0) throw IllegalArgumentException("sampleRate must be > 0")
    if (samples.isEmpty()) throw IllegalArgumentException("samples must not be empty")
    if (channelCount != 1) throw IllegalArgumentException("Only mono (channelCount=1) is supported")

    val bufferId = "off_${UUID.randomUUID()}"
    val rawSize = samples.size.toLong() * 4
    val threshold = MmapThresholdPolicy.thresholdBytes(ThresholdPathType.HEAP_ORIGIN)
    val dir = cacheDir

    val selectedForMmap = rawSize >= threshold && dir != null
    val entry = if (selectedForMmap) {
      val mmapEntry = OfflineEntry.createMmapFromSamples(bufferId, sampleRate, channelCount, samples, dir)
      mmapEntry ?: OfflineEntry.InMemory(bufferId, sampleRate, channelCount, samples)
    } else {
      OfflineEntry.InMemory(bufferId, sampleRate, channelCount, samples)
    }
    offlineEntries[bufferId] = entry
    return entry
  }

  /**
   * Replace an existing offline entry (typically an empty output target) with a new entry.
   * Used when we want to upgrade an output buffer to file-backed mmap without needing
   * a full heap materialization of the final samples.
   */
  fun replaceOfflineEntry(bufferId: String, entry: OfflineEntry) {
    offlineEntries[bufferId]?.let { old ->
      try {
        old.releaseResources()
      } catch (_: Exception) {}
    }
    offlineEntries[bufferId] = entry
  }

  /**
   * Create an offline buffer from a pre-written raw float32 file.
   * The file is memory-mapped directly — no heap allocation of all samples.
   * Falls back to the old in-memory path only if mmap fails.
   *
   * @param f32FilePath Absolute path to an existing raw float32 file.
   * @param numSamples Total float32 sample count in the file.
   * @param sampleRate Output sample rate.
   */
  fun createOfflineFromMmapFile(
    f32FilePath: String,
    numSamples: Int,
    sampleRate: Int,
    channelCount: Int = 1
  ): OfflineEntry {
    if (sampleRate <= 0) throw IllegalArgumentException("sampleRate must be > 0")
    if (numSamples <= 0) throw IllegalArgumentException("numSamples must be > 0")
    if (channelCount != 1) throw IllegalArgumentException("Only mono (channelCount=1) is supported")

    val bufferId = "off_${UUID.randomUUID()}"
    val entry = OfflineEntry.createMmapFromFile(bufferId, sampleRate, channelCount, numSamples, f32FilePath)
      ?: throw RuntimeException("DECODE_INTERNAL_ERROR: Failed to mmap decoded file")
    offlineEntries[bufferId] = entry
    return entry
  }

  /**
   * Create an empty offline audio buffer as output target (e.g. for TTS synthesis).
   * Starts with no samples; native synthesis fills it exactly once via [adoptOfflineSamples].
   *
   * @param sampleRate Expected sample rate (must match model output rate for TTS).
   * @param channelCount Only mono (1) is supported.
   */
  fun createEmptyOffline(
    sampleRate: Int,
    channelCount: Int = 1
  ): OfflineEntry {
    if (sampleRate <= 0) throw IllegalArgumentException("sampleRate must be > 0")
    if (channelCount != 1) throw IllegalArgumentException("Only mono (channelCount=1) is supported")

    val bufferId = "off_${UUID.randomUUID()}"
    val entry = OfflineEntry.InMemory(
      bufferId = bufferId,
      sampleRate = sampleRate,
      channelCount = channelCount,
      samples = FloatArray(0)
    )
    offlineEntries[bufferId] = entry
    return entry
  }

  /**
   * Create an offline buffer from a live buffer.
   *
   * @param liveBufferId ID of the live buffer.
   * @param mode How to create the offline buffer:
    *   - "fullIfSpooled": If live has a spool file, use file-origin threshold policy.
   *     Otherwise, snapshot the ring.
   *   - "windowSnapshot": Always snapshot the current ring window (in-memory copy).
   */
  fun createOfflineFromLive(
    liveBufferId: String,
    mode: String = "fullIfSpooled"
  ): OfflineEntry {
    val live = requireLiveEntry(liveBufferId)

    val bufferId = "off_${UUID.randomUUID()}"

    return when (mode) {
      "fullIfSpooled" -> {
        val spoolPath = live.spoolFilePath
        if (spoolPath != null && live.state == LiveEntry.State.FINISHED) {
          createOfflineFromF32WavSpoolFile(bufferId, spoolPath, live.sampleRate, live.channelCount)
            ?: createFromRingSnapshot(bufferId, live)
        } else {
          createFromRingSnapshot(bufferId, live)
        }
      }
      "windowSnapshot" -> createFromRingSnapshot(bufferId, live)
      else -> throw IllegalArgumentException("Unknown mode: $mode. Use 'fullIfSpooled' or 'windowSnapshot'.")
    }
  }

  /**
   * Transfer ownership of a finalized live spool into a new offline buffer without copying.
   * After success, the source live buffer ID is invalidated and no longer usable.
   */
  fun transferOfflineFromLive(
    liveBufferId: String,
    mode: String = "fullIfSpooled"
  ): OfflineEntry {
    if (mode != "fullIfSpooled") {
      throw TransferException(
        PipelineAudioErrorCodes.INVALID_ARGUMENT,
        "Unsupported transfer mode: $mode. Use 'fullIfSpooled'."
      )
    }

    val live = liveEntries[liveBufferId]
      ?: if (isInvalidatedLiveBuffer(liveBufferId)) {
        throw TransferException(
          PipelineAudioErrorCodes.BUFFER_INVALIDATED,
          "Live buffer was transferred and is invalidated: $liveBufferId"
        )
      } else {
        throw TransferException(
          PipelineAudioErrorCodes.BUFFER_NOT_FOUND,
          "Live buffer not found: $liveBufferId"
        )
      }

    if (live.state != LiveEntry.State.FINISHED) {
      throw TransferException(
        PipelineAudioErrorCodes.TRANSFER_INVALID_STATE,
        "Live buffer must be finalized before transfer: $liveBufferId"
      )
    }

    if (live.activeCursorCount() > 0) {
      throw TransferException(
        PipelineAudioErrorCodes.TRANSFER_CURSORS_ACTIVE,
        "Live buffer has active cursors and cannot be transferred: $liveBufferId"
      )
    }

    val spoolPath = live.spoolFilePath
    if (spoolPath.isNullOrBlank()) {
      throw TransferException(
        PipelineAudioErrorCodes.TRANSFER_SPOOL_UNAVAILABLE,
        "Live buffer has no spool file to transfer: $liveBufferId"
      )
    }

    val spoolFile = File(spoolPath)
    if (!spoolFile.exists() || spoolFile.length() <= 44L) {
      throw TransferException(
        PipelineAudioErrorCodes.TRANSFER_SPOOL_UNAVAILABLE,
        "Spool file missing or empty: $spoolPath"
      )
    }

    val bufferId = "off_${UUID.randomUUID()}"
    val entry = createOfflineFromWavSpoolTransfer(
      bufferId = bufferId,
      spoolPath = spoolPath,
      sampleRate = live.sampleRate,
      channelCount = live.channelCount,
    ) ?: throw TransferException(
      PipelineAudioErrorCodes.INTERNAL_ERROR,
      "Failed to transfer spool to offline buffer: $liveBufferId"
    )

    offlineEntries[bufferId] = entry
    live.detachSpoolForTransfer()
    liveEntries.remove(liveBufferId)
    invalidatedLiveIds.add(liveBufferId)
    return entry
  }

  private fun createFromRingSnapshot(bufferId: String, live: LiveEntry): OfflineEntry {
    val snapshot = live.snapshotRing()
    val entry = createEntryWithThreshold(bufferId, live.sampleRate, live.channelCount, snapshot)
    return entry
  }

  /**
   * Copy raw F32 bytes from a WAV F32 spool file (skip 44-byte header) to a .f32 temp file, then mmap.
   * Returns the OfflineEntry, or null if conversion fails (caller falls back to ring snapshot).
   */
  private fun createOfflineFromF32WavSpoolFile(
    bufferId: String,
    spoolPath: String,
    sampleRate: Int,
    channelCount: Int,
  ): OfflineEntry? {
    val dir = cacheDir ?: return null
    val f32File = File(dir, "pa_off_${bufferId}.f32")

    return try {
      // Skip 44-byte WAV header, copy raw F32 bytes directly
      File(spoolPath).inputStream().use { input ->
        var remaining = 44L
        while (remaining > 0L) {
          val skipped = input.skip(remaining)
          if (skipped > 0L) {
            remaining -= skipped
            continue
          }
          if (input.read() == -1) throw RuntimeException("Failed to skip WAV header")
          remaining -= 1L
        }
        f32File.outputStream().use { output ->
          input.copyTo(output, bufferSize = 32768)
        }
      }

      val numSamples = (f32File.length() / 4).toInt()
      if (numSamples <= 0) {
        f32File.delete()
        return null
      }

      val rawSize = f32File.length()
      val threshold = MmapThresholdPolicy.thresholdBytes(ThresholdPathType.FILE_ORIGIN)

      val shouldMmap = rawSize >= threshold
      val entry = if (shouldMmap) {
        val mmapEntry = OfflineEntry.createMmapFromFile(
          bufferId,
          sampleRate,
          channelCount,
          numSamples,
          f32File.absolutePath
        )
        if (mmapEntry == null) {
                    f32File.delete()
          null
        } else {
                    mmapEntry
        }
      } else {
                val samples = FloatArray(numSamples)
        java.io.RandomAccessFile(f32File, "r").use { raf ->
          val bytes = ByteArray(numSamples * 4)
          raf.readFully(bytes)
          val bb = java.nio.ByteBuffer.wrap(bytes).order(java.nio.ByteOrder.LITTLE_ENDIAN)
          for (i in 0 until numSamples) {
            samples[i] = bb.float
          }
        }
        f32File.delete()
        OfflineEntry.InMemory(bufferId, sampleRate, channelCount, samples)
      }

      if (entry != null) {
        offlineEntries[bufferId] = entry
      }
      entry
    } catch (e: Exception) {
      Log.w(TAG, "createOfflineFromF32WavSpoolFile failed: ${e.message}")
      f32File.delete()
      null
    }
  }

  /**
   * Create an entry applying the mmap threshold: large → MmapBacked, small → InMemory.
   * Registers in offlineEntries.
   */
  internal fun createEntryWithThreshold(
    bufferId: String,
    sampleRate: Int,
    channelCount: Int,
    samples: FloatArray,
  ): OfflineEntry {
    val rawSize = samples.size.toLong() * 4
    val threshold = MmapThresholdPolicy.thresholdBytes(ThresholdPathType.HEAP_ORIGIN)
    val dir = cacheDir

    val selectedForMmap = rawSize >= threshold && dir != null
    val entry = if (selectedForMmap) {
      val mmapEntry = OfflineEntry.createMmapFromSamples(bufferId, sampleRate, channelCount, samples, dir)
      mmapEntry ?: OfflineEntry.InMemory(bufferId, sampleRate, channelCount, samples)
    } else {
      OfflineEntry.InMemory(bufferId, sampleRate, channelCount, samples)
    }
    offlineEntries[bufferId] = entry
    return entry
  }

  // Note: This still uses the old in-heap path because these scenarios have FloatArrays
  // that are already materialized:
  //   - JSI external calls: intentional, documented as power-user API
  //   - Ring snapshots: typically small (ring buffer is bounded)
  //   - Enhancement output: filled into pre-allocated empty buffer
  // For large file data, use file-based paths (decodeFileToOfflineBuffer, createOfflineFromLive).

  /**
   * Upgrade an InMemory entry to MmapBacked if it exceeds the threshold.
   * Used after adoptSamples() in enhancement output.
   * Atomically swaps the entry in the registry.
   */
  fun upgradeToMmapIfNeeded(bufferId: String) {
    // Upgrade an in-memory buffer to mmap if it exceeds the threshold.
    // Used when TTS/Enhancement output fills an initially-empty buffer.
    // This is safe because enhancement output is typically bounded (< 1-10 min audio),
    // and the buffer was already in heap before upgrade.
    val entry = offlineEntries[bufferId] ?: return
    if (entry !is OfflineEntry.InMemory) return
    val rawSize = entry.numSamples.toLong() * 4
    val threshold = MmapThresholdPolicy.thresholdBytes(ThresholdPathType.HEAP_ORIGIN)
    if (rawSize < threshold) {
            return
    }
    val dir = cacheDir ?: return
    
    val mmapEntry = OfflineEntry.createMmapFromSamples(
      entry.bufferId, entry.sampleRate, entry.channelCount, entry.samples, dir
    ) ?: return
    
    // Atomically replace in registry
    offlineEntries[bufferId] = mmapEntry
    entry.samples = FloatArray(0) // Release heap memory from old InMemory
  }

  /** Read a WAV spool into float32 samples. */
  private fun readWavToFloat32(filePath: String, metadata: FileBackedMetadata): FloatArray? {
    return try {
      val result = FloatArray(metadata.numSamples)
      FileBackedReader(filePath, metadata).use { reader ->
        var offset = 0
        val chunk = 8192
        while (offset < result.size) {
          val read = reader.readSamples(result, offset, minOf(chunk, result.size - offset))
          if (read <= 0) break
          offset += read
        }
      }
      result
    } catch (e: Exception) {
      Log.w(TAG, "Failed to read WAV spool: ${e.message}")
      null
    }
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
    isTemporarySpool: Boolean = false,
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
      isTemporarySpool = isTemporarySpool,
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
    val entry = requireLiveEntry(liveBufferId)
    if (entry.state != LiveEntry.State.RECORDING) {
      throw IllegalStateException("Live buffer is finalized, cannot append")
    }
    entry.appendSamples(samples, sampleRate, source)
  }

  /**
   * Append all samples from an offline buffer to a live buffer.
   */
  fun appendOfflineToLive(liveBufferId: String, offlineBufferId: String) {
    val live = requireLiveEntry(liveBufferId)
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
    minIntervalMs: Int? = null,
  ) {
    val entry = requireLiveEntry(liveBufferId)
    entry.configureAppendEvents(enabled, minIntervalMs)
  }

  fun setLiveFramesAppendedListener(
    liveBufferId: String,
    listener: ((LiveFramesAppendedEvent) -> Unit)?,
  ) {
    val entry = requireLiveEntry(liveBufferId)
    entry.setOnFramesAppendedListener(listener)
  }

  // ==================== Finalize Live Buffer ====================

  fun finalizeLive(liveBufferId: String) {
    val entry = requireLiveEntry(liveBufferId)
    entry.finalize_()
  }

  // ==================== Info / Release ====================

  /**
   * Get info for any buffer (offline or live).
   */
  fun getInfo(bufferId: String): WritableMap {
    offlineEntries[bufferId]?.let { return it.toWritableMap() }
    liveEntries[bufferId]?.let { return it.toWritableMap() }
    if (invalidatedLiveIds.contains(bufferId)) {
      throw IllegalStateException("Live buffer is invalidated after transfer: $bufferId")
    }
    throw IllegalArgumentException("Buffer not found: $bufferId")
  }

  /**
   * Release any buffer (offline or live).
   */
  fun release(bufferId: String): Boolean {
    offlineEntries.remove(bufferId)?.let {
      it.releaseResources()
      return true
    }
    liveEntries.remove(bufferId)?.let {
      it.release()
      return true
    }
    if (invalidatedLiveIds.remove(bufferId)) {
      return true
    }
    return false
  }

  // ==================== Accessors for pipeline stages ====================

  fun getOffline(bufferId: String): OfflineEntry? = offlineEntries[bufferId]
  fun getLive(bufferId: String): LiveEntry? = liveEntries[bufferId]
  fun isInvalidatedLiveBuffer(bufferId: String): Boolean = invalidatedLiveIds.contains(bufferId)

  /** Check whether a buffer ID refers to an offline entry. */
  fun isOffline(bufferId: String): Boolean = offlineEntries.containsKey(bufferId)

  /** Check whether a buffer ID refers to a live entry. */
  fun isLive(bufferId: String): Boolean = liveEntries.containsKey(bufferId)

  // ==================== JS Sample Slice (for debug/export) ====================

  /**
   * Get a slice of samples from a live buffer's ring for JS consumption.
   */
  fun getLiveSamplesSlice(liveBufferId: String, startFrame: Int, frameCount: Int): FloatArray {
    val entry = requireLiveEntry(liveBufferId)
    return entry.getSamplesSlice(startFrame, frameCount)
  }

  /**
   * Get a sample slice from an offline buffer for JSI/JNI callers.
   * Works for both InMemory and MmapBacked entries.
   */
  fun getOfflineSamplesSliceJni(
    bufferId: String,
    startFrame: Int,
    frameCount: Int,
  ): FloatArray {
    val entry = offlineEntries[bufferId]
      ?: throw IllegalArgumentException("[BUFFER_NOT_FOUND] $bufferId")

    if (frameCount <= 0) return FloatArray(0)
    return entry.readSlice(startFrame, frameCount)
  }

  /**
   * Get a sample slice from a live buffer ring for JSI/JNI callers.
   */
  fun getLiveSamplesSliceJni(
    bufferId: String,
    startFrame: Int,
    frameCount: Int,
  ): FloatArray {
    val entry = requireLiveEntry(bufferId)
    return entry.getSamplesSlice(startFrame.coerceAtLeast(0), frameCount)
  }

  /**
   * Create an offline buffer from Float32 samples and return info as JSON for JSI.
   */
  fun createOfflineFromFloatArrayJni(
    samples: FloatArray,
    sampleRate: Int,
    channelCount: Int,
  ): String {
    val entry = createOfflineFromFloatArray(samples, sampleRate, channelCount)
    return "{" +
      "\"bufferId\":\"${entry.bufferId}\"," +
      "\"kind\":\"offlinePcmBuffer\"," +
      "\"state\":\"immutable\"," +
      "\"sampleRate\":${entry.sampleRate}," +
      "\"channelCount\":${entry.channelCount}," +
      "\"numSamples\":${entry.numSamples}," +
      "\"durationMs\":${entry.durationMs}" +
      "}"
  }

  /**
   * Append Float32 samples to a live buffer from JSI/JNI.
   */
  fun appendSamplesToLiveJni(
    bufferId: String,
    samples: FloatArray,
    sampleRate: Int,
  ) {
    val entry = requireLiveEntry(bufferId)
    if (entry.state != LiveEntry.State.RECORDING) {
      throw IllegalStateException("[BUFFER_NOT_RECORDING] $bufferId")
    }
    entry.appendSamples(samples, sampleRate, LIVE_APPEND_SOURCE_APPEND)
  }

  private fun requireLiveEntry(liveBufferId: String): LiveEntry {
    liveEntries[liveBufferId]?.let { return it }
    if (invalidatedLiveIds.contains(liveBufferId)) {
      throw IllegalStateException("Live buffer is invalidated after transfer: $liveBufferId")
    }
    throw IllegalArgumentException("Live buffer not found: $liveBufferId")
  }

  private fun createOfflineFromWavSpoolTransfer(
    bufferId: String,
    spoolPath: String,
    sampleRate: Int,
    channelCount: Int,
  ): OfflineEntry? {
    val spoolFile = File(spoolPath)
    if (!spoolFile.exists()) return null

    val payloadBytes = spoolFile.length() - 44L
    if (payloadBytes <= 0L || payloadBytes % 4L != 0L) return null

    val numSamples = (payloadBytes / 4L).toInt()
    val threshold = MmapThresholdPolicy.thresholdBytes(ThresholdPathType.FILE_ORIGIN)
    val shouldMmap = spoolFile.length() >= threshold

    return if (shouldMmap) {
      OfflineEntry.createMmapFromFile(
        bufferId = bufferId,
        sampleRate = sampleRate,
        channelCount = channelCount,
        numSamples = numSamples,
        f32FilePath = spoolPath,
        dataOffsetBytes = 44,
      )
    } else {
      val out = FloatArray(numSamples)
      java.io.RandomAccessFile(spoolFile, "r").use { raf ->
        raf.seek(44L)
        val bytes = ByteArray(numSamples * 4)
        raf.readFully(bytes)
        val bb = java.nio.ByteBuffer.wrap(bytes).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        for (i in 0 until numSamples) {
          out[i] = bb.float
        }
      }
      OfflineEntry.InMemory(bufferId, sampleRate, channelCount, out)
    }
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
    offlineEntries.values.forEach { it.releaseResources() }
    offlineEntries.clear()
  }

}

class TransferException(
  val code: String,
  message: String,
) : RuntimeException(message)
