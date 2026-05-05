package com.sherpaonnx.audio.pipeline

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.sherpaonnx.segment.engine.SegmentationEngineRegistry
import android.os.SystemClock
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.read
import kotlin.concurrent.withLock
import kotlin.concurrent.write

/**
 * Live audio buffer entry in the pipeline registry.
 *
 * State machine: recording → finished → (released via registry)
 * No reverse transitions.
 *
 * ## Rolling Window (Ring Buffer)
 * - Fixed-capacity ring of Float32 samples.
 * - New samples overwrite oldest when full (producer always succeeds).
 * - `totalSamplesWritten` monotonically increases even when the window wraps.
 *
 * ## Optional Persistent Spool
 * - When persistence is enabled, all incoming samples are also written to a WAV file.
 * - After finalize(), the spool file's header is patched with the final sample count.
 * - If no spool is configured, `createOfflineFromLive(mode=fullIfSpooled)` only works after finalize
 *   and returns the ring contents (which may be truncated if recording > window).
 *
 * ## Native Consumer Cursor
 * - A single consumer cursor for native pipeline stages (STT-Streaming, etc.).
 * - Supports peek/drain semantics without copying to JS.
 * - Multiple consumers: each gets an independent cursor handle via [createCursorHandle].
 */

const val LIVE_APPEND_SOURCE_MIC = "mic"
const val LIVE_APPEND_SOURCE_APPEND = "append"
const val LIVE_APPEND_SOURCE_APPEND_OFFLINE = "append_offline"
const val LIVE_APPEND_SOURCE_ENHANCEMENT = "enhancement"
const val LIVE_APPEND_SOURCE_TTS = "tts"
const val LIVE_APPEND_SOURCE_FILE_INGEST = "file_ingest"
const val LIVE_APPEND_SOURCE_UNKNOWN = "unknown"
const val LIVE_APPEND_SOURCE_MIXED = "mixed"

data class LiveAppendEventConfig(
  val enabled: Boolean = false,
  val minIntervalMs: Int = 0,
)

data class LiveFramesAppendedEvent(
  val liveBufferId: String,
  val source: String,
  val sampleRate: Int,
  val frameCount: Int,
  val totalSamplesWritten: Long,
)

class LiveEntry(
  val bufferId: String,
  val sampleRate: Int,
  val channelCount: Int = 1,
  windowSeconds: Double = 60.0,
  persistence: PersistenceConfig? = null,
  appendEventConfig: LiveAppendEventConfig = LiveAppendEventConfig(),
  onFramesAppended: ((LiveFramesAppendedEvent) -> Unit)? = null,
  isTemporarySpool: Boolean = false,
) {
  enum class AppendResult {
    APPENDED,
    BUFFER_FINALIZED,
  }

  val kind: String = "livePcmBuffer"

  // ---------- State machine ----------
  enum class State { RECORDING, FINISHED }
  private val stateRef = AtomicReference(State.RECORDING)
  val state: State get() = stateRef.get()

  // ---------- Ring buffer ----------
  private val windowCapacity: Int = (windowSeconds * sampleRate).toInt().coerceAtLeast(sampleRate) // at least 1 second
  private val ring = FloatArray(windowCapacity)
  private var writePos = 0 // position in ring (wraps)
  @Volatile
  var totalSamplesWritten: Long = 0L
    private set
  @Volatile
  var ringEvictedSamples: Long = 0L
    private set

  // Lock: write-lock for append, read-lock for snapshot/peek
  private val rwLock = ReentrantReadWriteLock()

  // ---------- Backpressure ----------
  private val backpressureLock = ReentrantLock()
  private val cursorAdvanced = backpressureLock.newCondition()

  /**
   * Check whether appending [appendSize] samples would NOT overrun any active cursor.
   * Returns true when there is enough room (i.e., safe to append).
   */
  private fun wouldOverrunAnyCursor(appendSize: Long): Boolean {
    synchronized(cursors) {
      if (cursors.isEmpty()) return true // No cursors — no constraint
      val slowest = cursors.values.minOf { it.absoluteReadPos }
      // Room = distance from slowest cursor to ring capacity limit
      return (totalSamplesWritten + appendSize - slowest) <= windowCapacity
    }
  }

  /** Called after a cursor read advances. Wakes any blocked producer. */
  private fun notifyCursorAdvanced() {
    backpressureLock.withLock { cursorAdvanced.signalAll() }
  }

  // ---------- Spool (optional persistence) ----------
  @Volatile
  private var spoolWriter: SpoolWriter? = persistence?.let { SpoolWriter(it, sampleRate, channelCount) }
  @Volatile
  private var spoolReader: SpoolReader? = persistence?.let { SpoolReader(it.filePath) }
  val hasActiveSpool: Boolean get() = spoolWriter != null
  @Volatile
  private var isTemporarySpool: Boolean = isTemporarySpool

  /**
   * Activate a spool on a live buffer that was created without one.
   * Must be called while still in RECORDING state and before the first ingest chunk.
   *
   * @param config Persistence config with file path and format.
   * @param temporary If true, the spool file is deleted on release().
   */
  fun enableSpool(config: PersistenceConfig, temporary: Boolean = false) {
    check(state == State.RECORDING) { "Cannot enable spool on finalized buffer" }
    check(spoolWriter == null) { "Spool already active" }
    spoolWriter = SpoolWriter(config, sampleRate, channelCount)
    spoolReader = SpoolReader(config.filePath)
    isTemporarySpool = temporary
  }

  // ---------- Consumer cursors ----------
  private var nextCursorId = 0
  private val cursors = mutableMapOf<Int, CursorHandle>()

  // ---------- Append events ----------
  @Volatile
  private var appendEventsEnabled: Boolean = appendEventConfig.enabled
  @Volatile
  private var appendEventsMinIntervalMs: Int = appendEventConfig.minIntervalMs.coerceAtLeast(0)
  @Volatile
  private var onFramesAppendedListener: ((LiveFramesAppendedEvent) -> Unit)? = onFramesAppended

  // Multi-listener list for native pipeline workers (condition variable wakeup etc.)
  private val appendListeners = CopyOnWriteArrayList<(LiveFramesAppendedEvent) -> Unit>()

  fun addAppendListener(listener: (LiveFramesAppendedEvent) -> Unit) {
    appendListeners.add(listener)
  }

  fun removeAppendListener(listener: (LiveFramesAppendedEvent) -> Unit) {
    appendListeners.remove(listener)
  }

  private val appendEventLock = Any()
  private var lastAppendEventAtMs: Long = 0L
  private var pendingFrames: Int = 0
  private var pendingSource: String? = null

  /**
   * Duration of the current ring content in milliseconds.
   * While recording: min(totalSamplesWritten, windowCapacity) / sampleRate.
   * After finalize: totalSamplesWritten / sampleRate.
   */
  val durationMs: Double
    get() {
      val samples = if (state == State.FINISHED) {
        totalSamplesWritten
      } else {
        minOf(totalSamplesWritten, windowCapacity.toLong())
      }
      return if (sampleRate > 0) (samples.toDouble() / sampleRate) * 1000.0 else 0.0
    }

  val numSamples: Long
    get() = if (state == State.FINISHED) totalSamplesWritten else minOf(totalSamplesWritten, windowCapacity.toLong())

  fun toWritableMap(): WritableMap {
    val map = Arguments.createMap()
    map.putString("bufferId", bufferId)
    map.putString("kind", kind)
    map.putString("state", if (state == State.RECORDING) "recording" else "finished")
    map.putDouble("sampleRate", sampleRate.toDouble())
    map.putInt("channelCount", channelCount)
    map.putDouble("numSamples", numSamples.toDouble())
    map.putDouble("durationMs", durationMs)
    map.putDouble("totalSamplesWritten", totalSamplesWritten.toDouble())
    map.putDouble("ringEvictedSamples", ringEvictedSamples.toDouble())
    map.putBoolean("hasActiveSpool", hasActiveSpool)
    return map
  }

  // ========== Append (recording only) ==========

  /**
   * Append Float32 samples. Thread-safe.
   *
   * @param backpressure If true, blocks until the slowest cursor has room in the ring
   *   for this append. File ingest uses this to prevent ring overflow and avoid data loss.
   *   Mic and JS append should use `backpressure = false` (default).
   * @throws IllegalStateException if buffer is finalized.
   * @throws InterruptedException if the calling thread is interrupted while waiting for backpressure.
   */
  fun tryAppendSamples(
    samples: FloatArray,
    inputSampleRate: Int = sampleRate,
    source: String = LIVE_APPEND_SOURCE_UNKNOWN,
    backpressure: Boolean = false,
  ): AppendResult {
    if (state != State.RECORDING) {
      return AppendResult.BUFFER_FINALIZED
    }

    val toAppend = if (inputSampleRate != sampleRate) {
      Resampler.resampleLinear(samples, inputSampleRate, sampleRate)
    } else {
      samples
    }

    // Backpressure: wait until the slowest cursor has enough room
    if (backpressure) {
      backpressureLock.withLock {
        while (state == State.RECORDING && !wouldOverrunAnyCursor(toAppend.size.toLong())) {
          // Wait with timeout to re-check state (finalize/release can unblock)
          cursorAdvanced.await(20, TimeUnit.MILLISECONDS)
        }
      }
      // If finalized while waiting, bail out
      if (state != State.RECORDING) return AppendResult.BUFFER_FINALIZED
    }

    var ringCommitted = false
    rwLock.write {
      // Finalize can race between the fast-path check above and taking the write lock.
      if (state != State.RECORDING) return@write
      ringCommitted = true
      for (s in toAppend) {
        ring[writePos] = s
        writePos = (writePos + 1) % windowCapacity
      }
      val prevTotal = totalSamplesWritten
      totalSamplesWritten = prevTotal + toAppend.size
      val usedBefore = minOf(prevTotal, windowCapacity.toLong())
      if (usedBefore == windowCapacity.toLong()) {
        ringEvictedSamples += toAppend.size
      } else {
        val overflow = (prevTotal + toAppend.size) - windowCapacity
        if (overflow > 0) {
          ringEvictedSamples += overflow
        }
      }
    }
    if (!ringCommitted) return AppendResult.BUFFER_FINALIZED

    // Write to spool file (outside ring lock for better concurrency)
    spoolWriter?.let { writer ->
      writer.append(toAppend)
      spoolReader?.committedSamples = writer.committedSamples
    }

    dispatchFramesAppended(toAppend, source)

    // Notify native pipeline listeners (immediate, no throttling)
    if (appendListeners.isNotEmpty()) {
      val event = LiveFramesAppendedEvent(
        liveBufferId = bufferId,
        source = source,
        sampleRate = sampleRate,
        frameCount = toAppend.size,
        totalSamplesWritten = totalSamplesWritten,
      )
      for (listener in appendListeners) {
        listener(event)
      }
    }

    SegmentationEngineRegistry.onLiveAudioWrite(
      bufferId = bufferId,
      chunk = toAppend,
      sampleRate = sampleRate,
      totalSamplesWritten = totalSamplesWritten,
    )

    return AppendResult.APPENDED
  }

  fun appendSamples(
    samples: FloatArray,
    inputSampleRate: Int = sampleRate,
    source: String = LIVE_APPEND_SOURCE_UNKNOWN,
    backpressure: Boolean = false,
  ) {
    val result = tryAppendSamples(samples, inputSampleRate, source, backpressure)
    check(result == AppendResult.APPENDED) { "Cannot append to finalized LiveBuffer" }
  }

  fun configureAppendEvents(
    enabled: Boolean? = null,
    minIntervalMs: Int? = null,
  ) {
    synchronized(appendEventLock) {
      enabled?.let { appendEventsEnabled = it }
      minIntervalMs?.let { appendEventsMinIntervalMs = it.coerceAtLeast(0) }
      if (!appendEventsEnabled) {
        pendingFrames = 0
        pendingSource = null
      }
    }
  }

  fun setOnFramesAppendedListener(listener: ((LiveFramesAppendedEvent) -> Unit)?) {
    synchronized(appendEventLock) {
      onFramesAppendedListener = listener
    }
  }

  fun flushFramesAppendedEvents() {
    flushPendingFramesAppendedEvent()
  }

  private fun dispatchFramesAppended(appendedSamples: FloatArray, source: String) {
    val listener = onFramesAppendedListener ?: return
    if (!appendEventsEnabled) return

    var eventToEmit: LiveFramesAppendedEvent? = null
    synchronized(appendEventLock) {
      pendingFrames += appendedSamples.size
      pendingSource = when (pendingSource) {
        null -> source
        source -> source
        else -> LIVE_APPEND_SOURCE_MIXED
      }

      val now = SystemClock.elapsedRealtime()
      val shouldEmit = appendEventsMinIntervalMs <= 0 ||
        lastAppendEventAtMs == 0L ||
        (now - lastAppendEventAtMs) >= appendEventsMinIntervalMs

      if (shouldEmit) {
        eventToEmit = buildPendingFramesAppendedEventLocked()
        lastAppendEventAtMs = now
      }
    }

    eventToEmit?.let(listener)
  }

  private fun flushPendingFramesAppendedEvent() {
    val listener = onFramesAppendedListener ?: return
    if (!appendEventsEnabled) return

    val event = synchronized(appendEventLock) {
      buildPendingFramesAppendedEventLocked()
    }
    event?.let(listener)
  }

  private fun buildPendingFramesAppendedEventLocked(): LiveFramesAppendedEvent? {
    if (pendingFrames <= 0) return null

    val source = pendingSource ?: LIVE_APPEND_SOURCE_UNKNOWN
    val frameCount = pendingFrames
    val totalWritten = totalSamplesWritten

    pendingFrames = 0
    pendingSource = null

    return LiveFramesAppendedEvent(
      liveBufferId = bufferId,
      source = source,
      sampleRate = sampleRate,
      frameCount = frameCount,
      totalSamplesWritten = totalWritten,
    )
  }

  // ========== Finalize ==========

  /**
   * Finalize the buffer. No more appends allowed.
   * Patches spool file header if persistence is active.
   */
  fun finalize_() {
    if (!stateRef.compareAndSet(State.RECORDING, State.FINISHED)) {
      return // already finalized, idempotent
    }
    spoolWriter?.finalize_()
    flushPendingFramesAppendedEvent()

    // Wake any blocked producers (backpressure)
    notifyCursorAdvanced()

    // Wake pipeline workers so they detect the FINISHED state immediately
    if (appendListeners.isNotEmpty()) {
      val event = LiveFramesAppendedEvent(
        liveBufferId = bufferId,
        source = LIVE_APPEND_SOURCE_UNKNOWN,
        sampleRate = sampleRate,
        frameCount = 0,
        totalSamplesWritten = totalSamplesWritten,
      )
      for (listener in appendListeners) {
        listener(event)
      }
    }

    SegmentationEngineRegistry.onBufferFinalized(bufferId)
  }

  // ========== Snapshot / Read ==========

  /**
   * Snapshot the current ring content as a contiguous FloatArray.
   * Returns samples in chronological order (oldest first).
   */
  fun snapshotRing(): FloatArray {
    rwLock.read {
      val used = minOf(totalSamplesWritten, windowCapacity.toLong()).toInt()
      if (used == 0) return FloatArray(0)

      val out = FloatArray(used)
      if (totalSamplesWritten <= windowCapacity) {
        // Ring hasn't wrapped yet; data is [0, used)
        System.arraycopy(ring, 0, out, 0, used)
      } else {
        // Ring has wrapped; writePos points to oldest sample
        val firstPart = windowCapacity - writePos
        System.arraycopy(ring, writePos, out, 0, firstPart)
        System.arraycopy(ring, 0, out, firstPart, writePos)
      }
      return out
    }
  }

  /**
   * Get a slice of samples from the ring.
   * [startFrame] is relative to the current ring content (0 = oldest available).
   */
  fun getSamplesSlice(startFrame: Int, frameCount: Int): FloatArray {
    rwLock.read {
      val used = minOf(totalSamplesWritten, windowCapacity.toLong()).toInt()
      if (startFrame >= used || frameCount <= 0) return FloatArray(0)

      val actualCount = minOf(frameCount, used - startFrame)
      val out = FloatArray(actualCount)

      val ringStart = if (totalSamplesWritten <= windowCapacity) {
        startFrame
      } else {
        (writePos + startFrame) % windowCapacity
      }

      for (i in 0 until actualCount) {
        out[i] = ring[(ringStart + i) % windowCapacity]
      }
      return out
    }
  }

  /** Path to the spool WAV file, if persistence is active and the file exists. */
  val spoolFilePath: String? get() = spoolWriter?.filePath

  /** Number of currently active consumer cursors. */
  fun activeCursorCount(): Int = synchronized(cursors) { cursors.size }

  /**
   * Close spool I/O handles and detach ownership for transfer to an offline buffer.
   * The source live entry should be removed from registry immediately after this call.
   */
  fun detachSpoolForTransfer() {
    spoolWriter?.release()
    spoolReader?.release()
    spoolWriter = null
    spoolReader = null
    isTemporarySpool = false
  }

  // ========== Consumer Cursor ==========

  /**
   * Create a new independent consumer cursor for native pipeline stages.
   * Starts reading from the current oldest available sample.
   * Returns a cursor handle ID.
   */
  fun createCursorHandle(): Int {
    synchronized(cursors) {
      val id = nextCursorId++
      val cursor = CursorHandle(
        cursorId = id,
        // When spool is active, start from absolute 0 so cursor can read all data.
        // Ring-only: start at the oldest sample still retained in the ring.
        absoluteReadPos = if (hasActiveSpool) {
          0L
        } else if (totalSamplesWritten > windowCapacity) {
          totalSamplesWritten - windowCapacity
        } else {
          0L
        }
      )
      cursors[id] = cursor
      return id
    }
  }

  /**
   * Peek at available samples for a cursor without advancing it.
   * Returns up to [maxSamples] new samples that this cursor hasn't read yet.
   */
  fun peekCursor(cursorId: Int, maxSamples: Int): FloatArray {
    val cursor = synchronized(cursors) { cursors[cursorId] } ?: return FloatArray(0)
    return readFromCursorDispatch(cursor, maxSamples, advance = false)
  }

  /**
   * Drain samples from a cursor, advancing its position.
   * Returns up to [maxSamples] new samples.
   */
  fun drainCursor(cursorId: Int, maxSamples: Int): FloatArray {
    val cursor = synchronized(cursors) { cursors[cursorId] } ?: return FloatArray(0)
    val result = readFromCursorDispatch(cursor, maxSamples, advance = true)
    if (result.isNotEmpty()) {
      notifyCursorAdvanced()
    }
    return result
  }

  /** Release a cursor handle. */
  fun releaseCursor(cursorId: Int) {
    synchronized(cursors) { cursors.remove(cursorId) }
  }

  /** Seek a cursor to an absolute sample position. Clamped to available range. */
  fun seekCursor(cursorId: Int, absolutePos: Long) {
    synchronized(cursors) {
      cursors[cursorId]?.absoluteReadPos = absolutePos
    }
  }

  /** Get the oldest absolute sample position currently available in the ring. */
  fun oldestAvailablePos(): Long =
    if (totalSamplesWritten > windowCapacity) totalSamplesWritten - windowCapacity else 0L

  /**
   * Dispatch cursor read: ring fast-path (under rwLock) or spool slow-path (independent I/O).
   * This avoids holding the ring rwLock during file I/O.
   */
  private fun readFromCursorDispatch(cursor: CursorHandle, maxSamples: Int, advance: Boolean): FloatArray {
    // Snapshot volatile state for dispatch decision
    val readPos = cursor.absoluteReadPos
    val written = totalSamplesWritten
    val oldestInRing = if (written > windowCapacity) written - windowCapacity else 0L

    if (readPos >= oldestInRing) {
      // Fast path: cursor is within ring — read under rwLock
      return rwLock.read { readFromRing(cursor, maxSamples, advance) }
    }

    // Slow path: cursor is behind the ring — try spool outside rwLock
    val reader = spoolReader
    if (reader != null) {
      val available = (written - readPos).toInt().coerceAtLeast(0)
      if (available == 0) return FloatArray(0)

      val count = minOf(maxSamples, available)
      val spoolCommitted = reader.committedSamples
      val spoolEnd = minOf(spoolCommitted, written)
      // Read only what the spool has committed; if cursor is partially in spool and partially in ring,
      // read spool portion only this iteration — next call will pick up ring portion.
      val safeEnd = minOf(readPos + count, spoolEnd)
      val spoolCount = (safeEnd - readPos).toInt().coerceAtLeast(0)

      if (spoolCount > 0) {
        val out = reader.read(readPos, spoolCount)
        if (out != null && out.isNotEmpty()) {
          if (advance) {
            cursor.absoluteReadPos = readPos + out.size
          }
          return out
        }
      }
    }

    // No spool or read failed — fall back to ring with snap-forward
    // If cursor was truly behind ring AND spool didn't help, this is a lag error
    // when the buffer has (or had) a spool. For ring-only buffers (no spool ever),
    // snap the read position forward to the ring window (recoverable lag).
    if (spoolReader != null) {
      throw CursorLagExceededException(
        "AUDIO_CURSOR_LAG_EXCEEDED: Cursor at position $readPos has fallen behind retained data (oldest in ring: $oldestInRing). " +
        "Spool read failed or data was trimmed beyond cursor position."
      )
    }
    return rwLock.read { readFromRing(cursor, maxSamples, advance) }
  }

  /** Read from ring buffer. Snaps cursor forward if behind ring window. Must be called under rwLock.read. */
  private fun readFromRing(cursor: CursorHandle, maxSamples: Int, advance: Boolean): FloatArray {
    val oldestInRing = if (totalSamplesWritten > windowCapacity) {
      totalSamplesWritten - windowCapacity
    } else {
      0L
    }

    val readPos = maxOf(cursor.absoluteReadPos, oldestInRing)
    val available = (totalSamplesWritten - readPos).toInt().coerceAtLeast(0)
    if (available == 0) return FloatArray(0)

    val count = minOf(maxSamples, available)
    val out = FloatArray(count)
    val ringOffset = (readPos % windowCapacity).toInt()
    for (i in 0 until count) {
      out[i] = ring[(ringOffset + i) % windowCapacity]
    }
    if (advance) {
      cursor.absoluteReadPos = readPos + count
    }
    return out
  }

  // ========== Release ==========

  fun release() {
    if (state == State.RECORDING) {
      finalize_()
    }
    flushPendingFramesAppendedEvent()
    val path = spoolWriter?.filePath
    spoolWriter?.release()
    spoolReader?.release()
    spoolReader = null
    if (isTemporarySpool && path != null) {
      try { File(path).delete() } catch (_: Exception) {}
    }
    synchronized(cursors) { cursors.clear() }

    SegmentationEngineRegistry.onBufferReleased(bufferId)
  }

  // ========== Inner classes ==========

  class CursorHandle(
    val cursorId: Int,
    @Volatile var absoluteReadPos: Long
  )
}

// ========== Cursor Lag Error ==========

/**
 * Thrown when a cursor has fallen irrecoverably behind retained data.
 * The consumer should treat this as a terminal pipeline error.
 */
class CursorLagExceededException(message: String) : RuntimeException(message)

// ========== Persistence Configuration ==========

/** Retention mode for the spool file. */
enum class RetentionMode {
  /** Spool exists; trimmed to max(ringSeconds, slowest cursor lag). */
  AUTO,
  /** Spool retains every sample until buffer release. */
  SESSION,
  /** Spool retains up to N seconds. */
  MAX_SECONDS,
  /** Explicit on-disk persistence path. */
  PATH,
  /** No spool; ring-only. */
  NONE,
}

data class PersistenceConfig(
  val filePath: String,
  val retentionMode: RetentionMode = RetentionMode.SESSION,
  val retentionSeconds: Double = 0.0,
)

// ========== Spool Writer ==========

/**
 * Writes incoming samples to a WAV file incrementally.
 * Header is written immediately with placeholder sizes; finalize patches the sizes.
 */
internal class SpoolWriter(
  private val config: PersistenceConfig,
  private val sampleRate: Int,
  private val channelCount: Int
) {
  val filePath: String = config.filePath
  private var raf: RandomAccessFile? = null
  @Volatile
  var committedSamples = 0L
    private set
  private val lock = Object()

  init {
    val file = File(filePath)
    file.parentFile?.mkdirs()
    raf = RandomAccessFile(file, "rw")
    raf!!.setLength(0)
    writeWavHeader()
  }

  private fun writeWavHeader() {
    val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
    header.put("RIFF".toByteArray(Charsets.US_ASCII))
    header.putInt(0) // placeholder for file size - 8
    header.put("WAVE".toByteArray(Charsets.US_ASCII))
    header.put("fmt ".toByteArray(Charsets.US_ASCII))
    header.putInt(16)
    header.putShort(3) // audioFormat = IEEE Float
    header.putShort(channelCount.toShort())
    header.putInt(sampleRate)
    header.putInt(sampleRate * channelCount * 4) // byteRate
    header.putShort((channelCount * 4).toShort()) // blockAlign
    header.putShort(32) // bitsPerSample
    header.put("data".toByteArray(Charsets.US_ASCII))
    header.putInt(0) // placeholder for data size
    raf!!.write(header.array())
  }

  fun append(samples: FloatArray) {
    synchronized(lock) {
      val r = raf ?: return
      val buf = ByteBuffer.allocate(samples.size * 4).order(ByteOrder.LITTLE_ENDIAN)
      for (s in samples) buf.putFloat(s)
      r.write(buf.array())
      committedSamples += samples.size
    }
  }

  /** Patch the WAV header with final sizes and close the file. */
  fun finalize_() {
    synchronized(lock) {
      val r = raf ?: return
      val dataSize = committedSamples * 4
      val fileSize = 44 + dataSize

      // Patch RIFF size (offset 4)
      r.seek(4)
      val sizeBuf = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN)
      sizeBuf.putInt((fileSize - 8).toInt())
      r.write(sizeBuf.array())

      // Patch data size (offset 40)
      r.seek(40)
      val dataSizeBuf = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN)
      dataSizeBuf.putInt(dataSize.toInt())
      r.write(dataSizeBuf.array())

      r.close()
      raf = null
    }
  }

  fun release() {
    synchronized(lock) {
      try { raf?.close() } catch (_: Exception) {}
      raf = null
    }
  }
}

// ========== Spool Reader ==========

/**
 * Reads samples from a F32 WAV spool file at arbitrary absolute positions.
 * Thread-safe: uses a separate RandomAccessFile opened in read-only mode.
 * The committedSamples count is obtained from the associated SpoolWriter to
 * avoid reading bytes that haven't been flushed yet.
 */
internal class SpoolReader(
  private val filePath: String
) {
  companion object {
    private const val WAV_HEADER_SIZE = 44
    private const val BYTES_PER_SAMPLE = 4
  }

  private var raf: RandomAccessFile? = null
  private val lock = Object()

  /**
   * Number of samples safely committed by the writer.
   * Updated by [LiveEntry] after each SpoolWriter.append().
   */
  @Volatile
  var committedSamples: Long = 0L

  init {
    try {
      raf = RandomAccessFile(File(filePath), "r")
    } catch (_: Exception) {
      // Spool file might not exist yet; will retry on first read
    }
  }

  /**
   * Read [count] samples starting at absolute sample position [absolutePos].
   * Returns null if the spool file is not available or the requested range
   * extends beyond committed bytes.
   */
  fun read(absolutePos: Long, count: Int): FloatArray? {
    if (count <= 0 || absolutePos < 0) return null

    synchronized(lock) {
      var r = raf
      if (r == null) {
        // Retry open — file may have been created after SpoolReader was constructed
        try {
          r = RandomAccessFile(File(filePath), "r")
          raf = r
        } catch (_: Exception) {
          return null
        }
      }

      // Clamp to committed range
      val safeEnd = minOf(absolutePos + count, committedSamples)
      val safeCount = (safeEnd - absolutePos).toInt()
      if (safeCount <= 0) return null

      val byteOffset = WAV_HEADER_SIZE + absolutePos * BYTES_PER_SAMPLE
      try {
        r.seek(byteOffset)
        val buf = ByteArray(safeCount * BYTES_PER_SAMPLE)
        r.readFully(buf)
        val bb = ByteBuffer.wrap(buf).order(ByteOrder.LITTLE_ENDIAN)
        val out = FloatArray(safeCount)
        for (i in 0 until safeCount) {
          out[i] = bb.getFloat()
        }
        return out
      } catch (_: Exception) {
        return null
      }
    }
  }

  fun release() {
    synchronized(lock) {
      try { raf?.close() } catch (_: Exception) {}
      raf = null
    }
  }
}
