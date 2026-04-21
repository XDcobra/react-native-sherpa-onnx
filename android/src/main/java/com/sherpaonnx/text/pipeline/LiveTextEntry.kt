package com.sherpaonnx.text.pipeline

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/**
 * A committed text segment in the segment log.
 */
data class TextSegment(
  val text: String,
  val tokens: Array<String>,
  val timestamps: FloatArray,
  val source: String,
  val segmentIndex: Int,
  val meta: Map<String, Any?>? = null,
)

enum class TextSpoolingMode {
  OFF,
  AUTO,
  ON;

  fun rawValue(): String = when (this) {
    OFF -> "off"
    AUTO -> "auto"
    ON -> "on"
  }

  companion object {
    fun fromRaw(raw: String?): TextSpoolingMode {
      return when (raw?.trim()?.lowercase()) {
        "off" -> OFF
        "auto" -> AUTO
        "on" -> ON
        null, "" -> ON
        else -> throw TextPipelineException(
          TextErrorCodes.INVALID_ARGUMENT,
          "Invalid text spooling mode: $raw. Use 'off', 'auto', or 'on'."
        )
      }
    }
  }
}

/**
 * Live text buffer entry in the pipeline registry.
 * State machine: RECORDING → FINISHED (no reverse).
 *
 * Holds the most recent partial text, revision counter,
 * optional ring of recent partial history, and a committed
 * segment log with independent cursors + append listeners.
 */
class LiveTextEntry(
  val bufferId: String,
  val windowMaxChars: Int = 65536,
  val maxSegments: Int = 1000,
  val emitPartialEvents: Boolean = false,
  val partialEventMinIntervalMs: Long = 0,
  private val spoolingMode: TextSpoolingMode = TextSpoolingMode.ON,
  private val spoolPath: String? = null,
  private val spoolTemporary: Boolean = true,
  private val spoolThresholdBytes: Long = 0,
) {
  enum class State { RECORDING, FINISHED }

  @Volatile
  var state: State = State.RECORDING
    private set

  /** Current partial/final text. */
  @Volatile
  var currentText: String = ""
    private set

  /** Monotonic total chars written (including full replacements). */
  @Volatile
  var totalCharsWritten: Long = 0
    private set

  private val _revision = AtomicInteger(0)
  val revision: Int get() = _revision.get()

  val kind: String = "liveTextBuffer"

  // ── Segment log (ring with maxSegments capacity) ──
  private val segments = ArrayList<TextSegment>()
  private val segmentLock = Any()
  @Volatile
  private var evictedCount: Long = 0

  /** Total number of committed segments currently in the log. */
  val segmentCount: Int get() = synchronized(segmentLock) { segments.size }

  // ── Cursor system (for downstream pipeline workers) ──
  private val cursors = ConcurrentHashMap<Int, AtomicInteger>()
  private val nextCursorId = AtomicInteger(0)

  // ── Append listeners (token-based, for condition variable wakeup) ──
  private val appendListeners = CopyOnWriteArrayList<Pair<Int, () -> Unit>>()
  private val nextListenerToken = AtomicInteger(0)

  // ── Text spool state ──
  private val spoolLock = Any()
  @Volatile
  private var spoolWriter: TextSpoolWriter? = null
  @Volatile
  private var spoolReady: Boolean = false
  @Volatile
  private var spoolBytes: Long = 0
  @Volatile
  private var spoolEstimatedBytes: Long = 0
  @Volatile
  private var spoolFailureCode: String? = null
  @Volatile
  private var spoolFailureMessage: String? = null

  init {
    if (spoolingEnabled() && spoolingMode == TextSpoolingMode.ON) {
      val initialSnapshot = snapshotFullTextForSpool()
      writeSnapshotToSpoolOrThrow(initialSnapshot, mayActivateAuto = false)
    }
  }

  private fun spoolingEnabled(): Boolean = spoolingMode != TextSpoolingMode.OFF

  private fun buildCommittedTextFromSegmentsLocked(): String {
    return buildString {
      segments.forEach { append(it.text) }
    }
  }

  private fun snapshotFullTextForSpool(): String {
    val committed = synchronized(segmentLock) { buildCommittedTextFromSegmentsLocked() }
    return committed + currentText
  }

  private fun markSpoolFailureAndThrow(
    code: String,
    message: String,
    cause: Throwable? = null,
  ): Nothing {
    spoolFailureCode = code
    spoolFailureMessage = message
    throw TextPipelineException(code, message, cause)
  }

  private fun ensureSpoolWriterActivatedLocked(bootstrapSnapshot: String) {
    if (spoolWriter != null) return
    val resolvedPath = spoolPath ?: markSpoolFailureAndThrow(
      TextErrorCodes.SPOOL_UNAVAILABLE,
      "Text spool path is not configured for live buffer: $bufferId"
    )

    val writer = try {
      TextSpoolWriter(resolvedPath)
    } catch (e: Exception) {
      markSpoolFailureAndThrow(
        TextErrorCodes.SPOOL_WRITE_FAILED,
        "Failed to create text spool for live buffer $bufferId: ${e.message}",
        e,
      )
    }

    try {
      writer.appendSnapshot(bootstrapSnapshot)
    } catch (e: Exception) {
      try {
        writer.release()
      } catch (_: Exception) {
        // ignore
      }
      markSpoolFailureAndThrow(
        TextErrorCodes.SPOOL_WRITE_FAILED,
        "Failed to initialize text spool for live buffer $bufferId: ${e.message}",
        e,
      )
    }

    spoolWriter = writer
    spoolReady = true
    spoolBytes = writer.bytesWritten
  }

  private fun writeSnapshotToSpoolOrThrow(snapshot: String, mayActivateAuto: Boolean) {
    if (!spoolingEnabled()) return

    val existingFailureCode = spoolFailureCode
    if (existingFailureCode != null) {
      throw TextPipelineException(
        existingFailureCode,
        spoolFailureMessage ?: "Text spool is unavailable for live buffer: $bufferId"
      )
    }

    synchronized(spoolLock) {
      val writer = spoolWriter
      if (writer == null) {
        when (spoolingMode) {
          TextSpoolingMode.OFF -> return
          TextSpoolingMode.ON -> {
            ensureSpoolWriterActivatedLocked(snapshot)
            return
          }
          TextSpoolingMode.AUTO -> {
            if (!mayActivateAuto) return
            val estimatedRecordBytes =
              TextSpoolWriter.RECORD_HEADER_BYTES + snapshot.toByteArray(StandardCharsets.UTF_8).size
            spoolEstimatedBytes += estimatedRecordBytes.toLong()
            if (spoolEstimatedBytes < spoolThresholdBytes.coerceAtLeast(0L)) {
              spoolReady = false
              return
            }
            ensureSpoolWriterActivatedLocked(snapshot)
            return
          }
        }
      }

      try {
        writer.appendSnapshot(snapshot)
        spoolReady = true
        spoolBytes = writer.bytesWritten
      } catch (e: Exception) {
        markSpoolFailureAndThrow(
          TextErrorCodes.SPOOL_WRITE_FAILED,
          "Failed to write text spool for live buffer $bufferId: ${e.message}",
          e,
        )
      }
    }
  }

  /**
   * Write/replace the current partial text. Increments revision.
   * @throws IllegalStateException if finalized.
   */
  @Synchronized
  fun writePartial(text: String) {
    if (state == State.FINISHED) throw IllegalStateException("Live text buffer is finalized: $bufferId")
    currentText = if (text.length > windowMaxChars) {
      text.substring(text.length - windowMaxChars)
    } else {
      text
    }
    totalCharsWritten += text.length
    _revision.incrementAndGet()

    val snapshot = snapshotFullTextForSpool()
    writeSnapshotToSpoolOrThrow(snapshot, mayActivateAuto = true)
  }

  /**
   * Append text to the current partial (for accumulative updates).
   * @throws IllegalStateException if finalized.
   */
  @Synchronized
  fun appendText(text: String) {
    if (state == State.FINISHED) throw IllegalStateException("Live text buffer is finalized: $bufferId")
    val combined = currentText + text
    currentText = if (combined.length > windowMaxChars) {
      combined.substring(combined.length - windowMaxChars)
    } else {
      combined
    }
    totalCharsWritten += text.length
    _revision.incrementAndGet()

    val snapshot = snapshotFullTextForSpool()
    writeSnapshotToSpoolOrThrow(snapshot, mayActivateAuto = true)
  }

  /**
   * Commit a finalized text segment to the segment log. Thread-safe.
   * Notifies append listeners (wakes downstream workers).
   * @throws IllegalStateException if finalized.
   */
  @Synchronized
  fun commitSegment(
    text: String,
    tokens: Array<String> = emptyArray(),
    timestamps: FloatArray = floatArrayOf(),
    source: String = "unknown",
    meta: Map<String, Any?>? = null,
  ): Int {
    var committedSegmentIndex = -1
    var snapshotAfterCommit = ""
    synchronized(segmentLock) {
      if (state == State.FINISHED) throw IllegalStateException("Live text buffer is finalized: $bufferId")
      val segmentIndex = (evictedCount + segments.size).toInt()
      val segment = TextSegment(
        text = text,
        tokens = tokens,
        timestamps = timestamps,
        source = source,
        segmentIndex = segmentIndex,
        meta = meta,
      )
      segments.add(segment)
      committedSegmentIndex = segmentIndex

      // Evict oldest if over capacity
      if (segments.size > maxSegments) {
        segments.removeAt(0)
        evictedCount++
        // Snap cursors forward
        for ((_, pos) in cursors) {
          val p = pos.get()
          if (p > 0) pos.decrementAndGet()
          else pos.set(0)
        }
      }
      totalCharsWritten += text.length
      _revision.incrementAndGet()
      snapshotAfterCommit = buildCommittedTextFromSegmentsLocked() + currentText
    }

    writeSnapshotToSpoolOrThrow(snapshotAfterCommit, mayActivateAuto = true)
    notifyAppendListeners()
    return committedSegmentIndex
  }

  /**
   * Read committed segments by index range. Thread-safe.
   */
  fun getSegments(startIndex: Int, maxCount: Int): List<TextSegment> {
    synchronized(segmentLock) {
      if (startIndex < 0 || startIndex >= segments.size) return emptyList()
      val end = minOf(startIndex + maxCount, segments.size)
      return ArrayList(segments.subList(startIndex, end))
    }
  }

  // ── Cursor system ──

  /** Create a new cursor starting at segment position 0. Returns cursor ID. */
  fun createSegmentCursor(): Int {
    val id = nextCursorId.getAndIncrement()
    cursors[id] = AtomicInteger(0)
    return id
  }

  /**
   * Drain up to maxCount unread segments from this cursor's position.
   * Advances the cursor. Returns empty list if no unread segments available.
   */
  fun drainSegments(cursorId: Int, maxCount: Int): List<TextSegment> {
    val pos = cursors[cursorId]
      ?: throw IllegalArgumentException("Segment cursor not found: $cursorId")
    synchronized(segmentLock) {
      val currentPos = pos.get()
      if (currentPos >= segments.size) return emptyList()
      val end = minOf(currentPos + maxCount, segments.size)
      val result = ArrayList(segments.subList(currentPos, end))
      pos.addAndGet(result.size)
      return result
    }
  }

  /** Release a cursor handle. */
  fun releaseSegmentCursor(cursorId: Int) {
    cursors.remove(cursorId)
  }

  // ── Append listeners ──

  fun addAppendListener(listener: () -> Unit): Int {
    val token = nextListenerToken.getAndIncrement()
    appendListeners.add(Pair(token, listener))
    return token
  }

  fun removeAppendListener(token: Int) {
    appendListeners.removeAll { it.first == token }
  }

  private fun notifyAppendListeners() {
    for ((_, listener) in appendListeners) {
      listener()
    }
  }

  /**
   * Finalize: RECORDING → FINISHED. Notifies append listeners.
   * @throws IllegalStateException if already finalized.
   */
  @Synchronized
  fun finalize_() {
    if (state == State.FINISHED) throw IllegalStateException("Already finalized: $bufferId")
    state = State.FINISHED

    synchronized(spoolLock) {
      try {
        spoolWriter?.finalize_()
      } catch (e: Exception) {
        markSpoolFailureAndThrow(
          TextErrorCodes.SPOOL_WRITE_FAILED,
          "Failed to finalize text spool for live buffer $bufferId: ${e.message}",
          e,
        )
      } finally {
        spoolWriter = null
      }
    }

    notifyAppendListeners()
  }

  fun toWritableMap(): WritableMap {
    val map = Arguments.createMap()
    map.putString("bufferId", bufferId)
    map.putString("kind", kind)
    map.putString("state", if (state == State.RECORDING) "recording" else "finished")
    map.putDouble("totalCharsWritten", totalCharsWritten.toDouble())
    map.putInt("revision", revision)
    map.putInt("segmentCount", segmentCount)
    map.putString("spoolMode", spoolingMode.rawValue())
    map.putBoolean("spoolEnabled", spoolingEnabled())
    map.putBoolean("spoolReady", spoolReady)
    map.putDouble("spoolBytes", spoolBytes.toDouble())
    if (!spoolPath.isNullOrEmpty()) {
      map.putString("spoolPath", spoolPath)
    }
    return map
  }

  /**
   * Snapshot current text window for creating offline from live in window mode.
   */
  fun snapshotText(): String = currentText

  /**
   * Read full text from spool for strict `fullIfSpooled` semantics.
   * Throws TEXT_SPOOL_* errors when unavailable or unreadable.
   */
  fun snapshotFullTextIfSpooled(): String {
    if (!spoolingEnabled()) {
      throw TextPipelineException(
        TextErrorCodes.SPOOL_UNAVAILABLE,
        "Text spooling is disabled for live buffer: $bufferId"
      )
    }

    val failureCode = spoolFailureCode
    if (failureCode != null) {
      throw TextPipelineException(
        failureCode,
        spoolFailureMessage ?: "Text spool is unavailable for live buffer: $bufferId"
      )
    }

    if (!spoolReady) {
      throw TextPipelineException(
        TextErrorCodes.SPOOL_UNAVAILABLE,
        "Text spool is not ready for live buffer: $bufferId"
      )
    }

    val path = spoolPath
      ?: throw TextPipelineException(
        TextErrorCodes.SPOOL_UNAVAILABLE,
        "Text spool path is missing for live buffer: $bufferId"
      )

    synchronized(spoolLock) {
      try {
        spoolWriter?.flush()
      } catch (e: Exception) {
        throw TextPipelineException(
          TextErrorCodes.SPOOL_READ_FAILED,
          "Failed to flush text spool before snapshot for live buffer $bufferId: ${e.message}",
          e,
        )
      }
    }

    return try {
      TextSpoolReader.readLatestSnapshot(path)
    } catch (e: TextPipelineException) {
      throw e
    } catch (e: IOException) {
      throw TextPipelineException(
        TextErrorCodes.SPOOL_READ_FAILED,
        "Failed to read text spool for live buffer $bufferId: ${e.message}",
        e,
      )
    }
  }

  fun release() {
    synchronized(spoolLock) {
      try {
        spoolWriter?.release()
      } catch (_: Exception) {
        // ignore release best-effort
      } finally {
        spoolWriter = null
      }
    }

    if (spoolTemporary && !spoolPath.isNullOrEmpty()) {
      try {
        File(spoolPath).delete()
      } catch (_: Exception) {
        // best-effort cleanup
      }
    }

    cursors.clear()
    appendListeners.clear()
  }
}

private class TextSpoolWriter(filePath: String) {
  companion object {
    const val RECORD_HEADER_BYTES = 4
  }

  private val raf: RandomAccessFile
  private val lock = Any()
  @Volatile
  private var closed = false

  @Volatile
  var bytesWritten: Long = 0
    private set

  init {
    val file = File(filePath)
    file.parentFile?.mkdirs()
    raf = RandomAccessFile(file, "rw")
    raf.setLength(0L)
    bytesWritten = 0L
  }

  fun appendSnapshot(text: String) {
    val payload = text.toByteArray(StandardCharsets.UTF_8)
    val header = ByteBuffer
      .allocate(RECORD_HEADER_BYTES)
      .order(ByteOrder.LITTLE_ENDIAN)
      .putInt(payload.size)
      .array()

    synchronized(lock) {
      if (closed) {
        throw IOException("Text spool writer is closed")
      }
      val recordLength = (RECORD_HEADER_BYTES + payload.size).toLong()
      raf.seek(0L)
      raf.write(header)
      raf.write(payload)
      raf.setLength(recordLength)
      bytesWritten = recordLength
    }
  }

  fun flush() {
    synchronized(lock) {
      if (closed) return
      raf.fd.sync()
      bytesWritten = raf.length()
    }
  }

  fun finalize_() {
    synchronized(lock) {
      if (closed) return
      raf.fd.sync()
      raf.close()
      closed = true
    }
  }

  fun release() {
    synchronized(lock) {
      if (closed) return
      try {
        raf.close()
      } finally {
        closed = true
      }
    }
  }
}

private object TextSpoolReader {
  private const val RECORD_HEADER_BYTES = 4

  fun readLatestSnapshot(filePath: String): String {
    val file = File(filePath)
    if (!file.exists()) {
      throw TextPipelineException(
        TextErrorCodes.SPOOL_UNAVAILABLE,
        "Text spool file does not exist: $filePath"
      )
    }

    RandomAccessFile(file, "r").use { raf ->
      val fileLength = raf.length()
      if (fileLength < RECORD_HEADER_BYTES) {
        throw TextPipelineException(
          TextErrorCodes.SPOOL_CORRUPTED,
          "Corrupted text spool record header in $filePath"
        )
      }

      raf.seek(0L)
      val header = ByteArray(RECORD_HEADER_BYTES)
      raf.readFully(header)
      val length = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN).int
      if (length < 0) {
        throw TextPipelineException(
          TextErrorCodes.SPOOL_CORRUPTED,
          "Corrupted text spool record length in $filePath"
        )
      }

      val expectedFileLength = RECORD_HEADER_BYTES + length.toLong()
      if (fileLength != expectedFileLength) {
        throw TextPipelineException(
          TextErrorCodes.SPOOL_CORRUPTED,
          "Unexpected text spool size in $filePath"
        )
      }

      val payload = ByteArray(length)
      if (length > 0) {
        raf.readFully(payload)
      }

      return String(payload, StandardCharsets.UTF_8)
    }
  }
}
