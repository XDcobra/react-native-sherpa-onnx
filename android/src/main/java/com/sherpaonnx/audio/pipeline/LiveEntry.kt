package com.sherpaonnx.audio.pipeline

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import android.os.SystemClock
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.read
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
const val LIVE_APPEND_SOURCE_UNKNOWN = "unknown"
const val LIVE_APPEND_SOURCE_MIXED = "mixed"

data class LiveAppendEventConfig(
  val enabled: Boolean = false,
  val includeSamples: Boolean = true,
  val minIntervalMs: Int = 0,
)

data class LiveFramesAppendedEvent(
  val liveBufferId: String,
  val source: String,
  val sampleRate: Int,
  val frameCount: Int,
  val totalSamplesWritten: Long,
  val samples: FloatArray?,
)

class LiveEntry(
  val bufferId: String,
  val sampleRate: Int,
  val channelCount: Int = 1,
  windowSeconds: Double = 60.0,
  persistence: PersistenceConfig? = null,
  appendEventConfig: LiveAppendEventConfig = LiveAppendEventConfig(),
  onFramesAppended: ((LiveFramesAppendedEvent) -> Unit)? = null,
) {
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
  var totalSamplesDropped: Long = 0L
    private set

  // Lock: write-lock for append, read-lock for snapshot/peek
  private val rwLock = ReentrantReadWriteLock()

  // ---------- Spool (optional persistence) ----------
  private val spoolWriter: SpoolWriter? = persistence?.let { SpoolWriter(it, sampleRate, channelCount) }
  val hasActiveSpool: Boolean get() = spoolWriter != null

  // ---------- Consumer cursors ----------
  private var nextCursorId = 0
  private val cursors = mutableMapOf<Int, CursorHandle>()

  // ---------- Append events ----------
  @Volatile
  private var appendEventsEnabled: Boolean = appendEventConfig.enabled
  @Volatile
  private var appendEventsIncludeSamples: Boolean = appendEventConfig.includeSamples
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
  private val pendingSampleChunks = mutableListOf<FloatArray>()
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
    map.putDouble("totalSamplesDropped", totalSamplesDropped.toDouble())
    map.putBoolean("hasActiveSpool", hasActiveSpool)
    return map
  }

  // ========== Append (recording only) ==========

  /**
   * Append Float32 samples. Thread-safe.
   * @throws IllegalStateException if buffer is finalized.
   */
  fun appendSamples(
    samples: FloatArray,
    inputSampleRate: Int = sampleRate,
    source: String = LIVE_APPEND_SOURCE_UNKNOWN,
  ) {
    check(state == State.RECORDING) { "Cannot append to finalized LiveBuffer" }

    val toAppend = if (inputSampleRate != sampleRate) {
      Resampler.resampleLinear(samples, inputSampleRate, sampleRate)
    } else {
      samples
    }

    rwLock.write {
      for (s in toAppend) {
        ring[writePos] = s
        writePos = (writePos + 1) % windowCapacity
      }
      val prevTotal = totalSamplesWritten
      totalSamplesWritten = prevTotal + toAppend.size
      val usedBefore = minOf(prevTotal, windowCapacity.toLong())
      val usedAfter = minOf(totalSamplesWritten, windowCapacity.toLong())
      if (usedBefore == windowCapacity.toLong()) {
        totalSamplesDropped += toAppend.size
      } else {
        val overflow = (prevTotal + toAppend.size) - windowCapacity
        if (overflow > 0) {
          totalSamplesDropped += overflow
        }
      }
    }

    // Write to spool file (outside ring lock for better concurrency)
    spoolWriter?.append(toAppend)

    dispatchFramesAppended(toAppend, source)

    // Notify native pipeline listeners (immediate, no throttling)
    if (appendListeners.isNotEmpty()) {
      val event = LiveFramesAppendedEvent(
        liveBufferId = bufferId,
        source = source,
        sampleRate = sampleRate,
        frameCount = toAppend.size,
        totalSamplesWritten = totalSamplesWritten,
        samples = null,
      )
      for (listener in appendListeners) {
        listener(event)
      }
    }
  }

  fun configureAppendEvents(
    enabled: Boolean? = null,
    includeSamples: Boolean? = null,
    minIntervalMs: Int? = null,
  ) {
    synchronized(appendEventLock) {
      enabled?.let { appendEventsEnabled = it }
      includeSamples?.let {
        appendEventsIncludeSamples = it
        if (!it) pendingSampleChunks.clear()
      }
      minIntervalMs?.let { appendEventsMinIntervalMs = it.coerceAtLeast(0) }
      if (!appendEventsEnabled) {
        pendingFrames = 0
        pendingSource = null
        pendingSampleChunks.clear()
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

      if (appendEventsIncludeSamples) {
        pendingSampleChunks.add(appendedSamples.copyOf())
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

    val samples = if (appendEventsIncludeSamples && pendingSampleChunks.isNotEmpty()) {
      val total = pendingSampleChunks.sumOf { it.size }
      val merged = FloatArray(total)
      var offset = 0
      for (chunk in pendingSampleChunks) {
        System.arraycopy(chunk, 0, merged, offset, chunk.size)
        offset += chunk.size
      }
      merged
    } else {
      null
    }

    pendingFrames = 0
    pendingSource = null
    pendingSampleChunks.clear()

    return LiveFramesAppendedEvent(
      liveBufferId = bufferId,
      source = source,
      sampleRate = sampleRate,
      frameCount = frameCount,
      totalSamplesWritten = totalWritten,
      samples = samples,
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

    // Wake pipeline workers so they detect the FINISHED state immediately
    if (appendListeners.isNotEmpty()) {
      val event = LiveFramesAppendedEvent(
        liveBufferId = bufferId,
        source = LIVE_APPEND_SOURCE_UNKNOWN,
        sampleRate = sampleRate,
        frameCount = 0,
        totalSamplesWritten = totalSamplesWritten,
        samples = null,
      )
      for (listener in appendListeners) {
        listener(event)
      }
    }
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
        // Start from the absolute position of the oldest sample currently in the ring
        absoluteReadPos = if (totalSamplesWritten > windowCapacity) {
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
    return rwLock.read {
      readFromCursor(cursor, maxSamples, advance = false)
    }
  }

  /**
   * Drain samples from a cursor, advancing its position.
   * Returns up to [maxSamples] new samples.
   */
  fun drainCursor(cursorId: Int, maxSamples: Int): FloatArray {
    val cursor = synchronized(cursors) { cursors[cursorId] } ?: return FloatArray(0)
    return rwLock.read {
      readFromCursor(cursor, maxSamples, advance = true)
    }
  }

  /** Release a cursor handle. */
  fun releaseCursor(cursorId: Int) {
    synchronized(cursors) { cursors.remove(cursorId) }
  }

  private fun readFromCursor(cursor: CursorHandle, maxSamples: Int, advance: Boolean): FloatArray {
    val oldestAvailable = if (totalSamplesWritten > windowCapacity) {
      totalSamplesWritten - windowCapacity
    } else {
      0L
    }

    // If cursor has fallen behind the ring, snap forward
    val readPos = maxOf(cursor.absoluteReadPos, oldestAvailable)
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

  // ========== Save ==========

  /**
   * Save current content to a WAV file.
   * - If spool is active: uses spool file (no RAM duplication).
   * - Otherwise: writes ring snapshot.
   */
  fun saveToWav(outputPath: String) {
    val spool = spoolWriter
    if (spool != null && state == State.FINISHED) {
      // Copy spool file (already a valid WAV after finalize)
      File(spool.filePath).copyTo(File(outputPath), overwrite = true)
    } else {
      // Write from ring snapshot
      val snapshot = snapshotRing()
      WavWriter.writeFloat32AsInt16Wav(snapshot, sampleRate, outputPath)
    }
  }

  // ========== Release ==========

  fun release() {
    if (state == State.RECORDING) {
      finalize_()
    }
    flushPendingFramesAppendedEvent()
    spoolWriter?.release()
    synchronized(cursors) { cursors.clear() }
  }

  // ========== Inner classes ==========

  class CursorHandle(
    val cursorId: Int,
    @Volatile var absoluteReadPos: Long
  )
}

// ========== Persistence Configuration ==========

data class PersistenceConfig(
  val filePath: String,
  val format: SpoolFormat = SpoolFormat.WAV_PCM_S16LE
)

enum class SpoolFormat {
  WAV_PCM_S16LE,
  WAV_PCM_FLOAT
}

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
  private var totalSamplesWritten = 0L
  private val isFloat = config.format == SpoolFormat.WAV_PCM_FLOAT
  private val bytesPerSample = if (isFloat) 4 else 2
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
    header.putShort(if (isFloat) 3 else 1) // audioFormat
    header.putShort(channelCount.toShort())
    header.putInt(sampleRate)
    header.putInt(sampleRate * channelCount * bytesPerSample) // byteRate
    header.putShort((channelCount * bytesPerSample).toShort()) // blockAlign
    header.putShort((bytesPerSample * 8).toShort()) // bitsPerSample
    header.put("data".toByteArray(Charsets.US_ASCII))
    header.putInt(0) // placeholder for data size
    raf!!.write(header.array())
  }

  fun append(samples: FloatArray) {
    synchronized(lock) {
      val r = raf ?: return
      val buf = ByteBuffer.allocate(samples.size * bytesPerSample).order(ByteOrder.LITTLE_ENDIAN)
      if (isFloat) {
        for (s in samples) buf.putFloat(s)
      } else {
        for (s in samples) {
          val clamped = s.coerceIn(-1.0f, 1.0f)
          buf.putShort((clamped * 32767.0f).toInt().coerceIn(-32768, 32767).toShort())
        }
      }
      r.write(buf.array())
      totalSamplesWritten += samples.size
    }
  }

  /** Patch the WAV header with final sizes and close the file. */
  fun finalize_() {
    synchronized(lock) {
      val r = raf ?: return
      val dataSize = totalSamplesWritten * bytesPerSample
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
