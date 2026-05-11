package com.sherpaonnx.text.pipeline

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.sherpaonnx.segment.engine.SegmentationEngineRegistry
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import java.util.zip.CRC32
import org.json.JSONObject

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
  val maxSegments: Int = 4096,
  val emitPartialEvents: Boolean = false,
  val partialEventMinIntervalMs: Long = 0,
  private val spoolingMode: TextSpoolingMode = TextSpoolingMode.ON,
  private val spoolPath: String? = null,
  private val spoolTemporary: Boolean = true,
  private val spoolThresholdBytes: Long = 0,
) {
  companion object {
    private const val TEXT_SPOOL_MAGIC = 0x32545854 // TXT2
    private const val TEXT_SPOOL_VERSION = 2
    private const val TEXT_SPOOL_HEADER_BYTES = 16
    private const val TEXT_SPOOL_PARTIAL_SET = 1
    private const val TEXT_SPOOL_PARTIAL_APPEND = 2
    private const val TEXT_SPOOL_SEGMENT_COMMIT = 3
    private const val TEXT_SPOOL_CHECKPOINT = 4
    private const val TEXT_SPOOL_FINALIZE = 5
    private const val TEXT_SPOOL_CHECKPOINT_EVERY_EVENTS = 128
    private const val TEXT_SPOOL_CHECKPOINT_EVERY_BYTES = 1_048_576L
  }
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

  // ── Commit listeners (token-based, for JS segment events) ──
  private val commitListeners = CopyOnWriteArrayList<Pair<Int, (TextSegment) -> Unit>>()
  private val nextCommitListenerToken = AtomicInteger(0)

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
  @Volatile
  private var journalEventCount: Int = 0
  @Volatile
  private var journalBytesSinceCheckpoint: Long = 0

  init {
    if (spoolingEnabled() && spoolingMode == TextSpoolingMode.ON) {
      val initialSnapshot = snapshotFullTextForSpool()
      writeTextSpoolOrThrow(
        mayActivateAuto = false,
        checkpointPayload = buildCheckpointPayload(initialSnapshot)
      )
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

  private fun journalPath(): String? = spoolPath?.let { "$it.txtj" }
  private fun checkpointPath(): String? = spoolPath?.let { "$it.txtc" }

  private fun buildCheckpointPayload(fullText: String): String {
    val escaped = fullText.replace("\\", "\\\\").replace("\"", "\\\"")
    return """{"fullText":"$escaped","totalCharsWritten":$totalCharsWritten,"revision":$revision}"""
  }

  private fun extractCheckpointText(payload: String): String {
    val marker = """"fullText":""""
    val idx = payload.indexOf(marker)
    if (idx < 0) return ""
    val start = payload.indexOf('"', idx + marker.length)
    if (start < 0) return ""
    val end = payload.indexOf('"', start + 1)
    if (end < 0) return ""
    return payload.substring(start + 1, end).replace("\\\"", "\"").replace("\\\\", "\\")
  }

  private fun appendSpoolRecordLocked(writer: TextSpoolWriter, recordType: Int, payload: String): Long {
    val payloadBytes = payload.toByteArray(StandardCharsets.UTF_8)
    val checksum = CRC32().apply { update(payloadBytes) }.value.toInt()
    val header = ByteBuffer
      .allocate(TEXT_SPOOL_HEADER_BYTES)
      .order(ByteOrder.LITTLE_ENDIAN)
      .putInt(TEXT_SPOOL_MAGIC)
      .putShort(TEXT_SPOOL_VERSION.toShort())
      .putShort(recordType.toShort())
      .putInt(payloadBytes.size)
      .putInt(checksum)
      .array()
    writer.appendRawRecord(header, payloadBytes)
    return (header.size + payloadBytes.size).toLong()
  }

  private fun writeCheckpointFile(checkpointPath: String, payload: String) {
    val tmpPath = "$checkpointPath.tmp"
    val tmpFile = RandomAccessFile(tmpPath, "rw")
    tmpFile.use { raf ->
      raf.setLength(0L)
      val payloadBytes = payload.toByteArray(StandardCharsets.UTF_8)
      val checksum = CRC32().apply { update(payloadBytes) }.value.toInt()
      val header = ByteBuffer
        .allocate(TEXT_SPOOL_HEADER_BYTES)
        .order(ByteOrder.LITTLE_ENDIAN)
        .putInt(TEXT_SPOOL_MAGIC)
        .putShort(TEXT_SPOOL_VERSION.toShort())
        .putShort(TEXT_SPOOL_CHECKPOINT.toShort())
        .putInt(payloadBytes.size)
        .putInt(checksum)
        .array()
      raf.write(header)
      raf.write(payloadBytes)
      raf.fd.sync()
    }
    val target = File(checkpointPath)
    if (target.exists() && !target.delete()) {
      throw TextPipelineException(TextErrorCodes.SPOOL_WRITE_FAILED, "Failed to replace text checkpoint: $checkpointPath")
    }
    if (!File(tmpPath).renameTo(target)) {
      throw TextPipelineException(TextErrorCodes.SPOOL_WRITE_FAILED, "Failed to finalize text checkpoint: $checkpointPath")
    }
  }

  private fun ensureSpoolWriterActivatedLocked(bootstrapSnapshot: String) {
    if (spoolWriter != null) return
    val basePath = spoolPath ?: markSpoolFailureAndThrow(
      TextErrorCodes.SPOOL_UNAVAILABLE,
      "Text spool path is not configured for live buffer: $bufferId"
    )
    val resolvedPath = "$basePath.txtj"

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
      val cpPath = checkpointPath()
        ?: markSpoolFailureAndThrow(TextErrorCodes.SPOOL_UNAVAILABLE, "Text checkpoint path missing for $bufferId")
      writeCheckpointFile(cpPath, buildCheckpointPayload(bootstrapSnapshot))
      appendSpoolRecordLocked(writer, TEXT_SPOOL_CHECKPOINT, "{}")
      journalEventCount = 0
      journalBytesSinceCheckpoint = 0L
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

  private fun writeTextSpoolOrThrow(
    mayActivateAuto: Boolean,
    recordType: Int? = null,
    recordPayload: String? = null,
    checkpointPayload: String? = null,
  ) {
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
            ensureSpoolWriterActivatedLocked(snapshotFullTextForSpool())
            return
          }
          TextSpoolingMode.AUTO -> {
            if (!mayActivateAuto) return
            val estimatedRecordBytes =
              TEXT_SPOOL_HEADER_BYTES + snapshotFullTextForSpool().toByteArray(StandardCharsets.UTF_8).size
            spoolEstimatedBytes += estimatedRecordBytes.toLong()
            if (spoolEstimatedBytes < spoolThresholdBytes.coerceAtLeast(0L)) {
              spoolReady = false
              return
            }
            ensureSpoolWriterActivatedLocked(snapshotFullTextForSpool())
            return
          }
        }
      }

      try {
        if (recordType != null && recordPayload != null) {
          val written = appendSpoolRecordLocked(writer, recordType, recordPayload)
          journalEventCount += 1
          journalBytesSinceCheckpoint += written
        }
        if (checkpointPayload != null && (
            journalEventCount >= TEXT_SPOOL_CHECKPOINT_EVERY_EVENTS ||
              journalBytesSinceCheckpoint >= TEXT_SPOOL_CHECKPOINT_EVERY_BYTES
            )
        ) {
          val cpPath = checkpointPath()
            ?: throw TextPipelineException(TextErrorCodes.SPOOL_UNAVAILABLE, "Text checkpoint path missing for $bufferId")
          writeCheckpointFile(cpPath, checkpointPayload)
          writer.truncate()
          appendSpoolRecordLocked(writer, TEXT_SPOOL_CHECKPOINT, "{}")
          journalEventCount = 0
          journalBytesSinceCheckpoint = 0L
        }
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

    // Streaming STT clears the partial window after commitSegment with
    // writePartial(""). Do not append TEXT_SPOOL_PARTIAL_SET with an empty
    // payload: snapshotFullTextIfSpooled replays the journal by replacing with
    // each PARTIAL_SET, so a trailing empty record would erase the transcript.
    if (text.isNotEmpty()) {
      writeTextSpoolOrThrow(
        mayActivateAuto = true,
        recordType = TEXT_SPOOL_PARTIAL_SET,
        recordPayload = text,
        checkpointPayload = buildCheckpointPayload(snapshotFullTextForSpool())
      )
    }

    SegmentationEngineRegistry.onLiveTextWrite(bufferId)
    TextPipelineRegistry.notifyLivePartialWritten(this, "replace")
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

    writeTextSpoolOrThrow(
      mayActivateAuto = true,
      recordType = TEXT_SPOOL_PARTIAL_APPEND,
      recordPayload = text,
      checkpointPayload = buildCheckpointPayload(snapshotFullTextForSpool())
    )

    SegmentationEngineRegistry.onLiveTextWrite(bufferId)
    TextPipelineRegistry.notifyLivePartialWritten(this, "append")
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
    var committedSegment: TextSegment? = null
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
      committedSegment = segment
      committedSegmentIndex = segmentIndex
      // Capture full history snapshot before any ring eviction. This preserves
      // strict fullIfSpooled guarantees even when maxSegments is exceeded.
      snapshotAfterCommit = buildCommittedTextFromSegmentsLocked() + currentText

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
    }

    writeTextSpoolOrThrow(
      mayActivateAuto = true,
      recordType = TEXT_SPOOL_SEGMENT_COMMIT,
      recordPayload = """{"text":${JSONObject.quote(text)}}""",
      checkpointPayload = buildCheckpointPayload(snapshotAfterCommit)
    )
    notifyAppendListeners()
    committedSegment?.let { notifyCommitListeners(it) }
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

  fun addCommitListener(listener: (TextSegment) -> Unit): Int {
    val token = nextCommitListenerToken.getAndIncrement()
    commitListeners.add(Pair(token, listener))
    return token
  }

  fun removeCommitListener(token: Int) {
    commitListeners.removeAll { it.first == token }
  }

  private fun notifyCommitListeners(segment: TextSegment) {
    for ((_, listener) in commitListeners) {
      listener(segment)
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
        spoolWriter?.let { writer ->
          appendSpoolRecordLocked(writer, TEXT_SPOOL_FINALIZE, "{}")
          writer.finalize_()
        }
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
    SegmentationEngineRegistry.onBufferFinalized(bufferId)
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

    val cpPath = "$path.txtc"
    val jPath = "$path.txtj"
    val hasSpool = File(cpPath).exists() || File(jPath).exists()
    if (hasSpool) {
      try {
        var fullText = ""
        val cpPayload = TextSpoolReader.readCheckpoint(cpPath)
        if (cpPayload != null) {
          fullText = extractCheckpointText(cpPayload)
        }
        TextSpoolReader.readJournal(jPath).forEach { rec ->
          when (rec.type) {
            TEXT_SPOOL_PARTIAL_SET -> fullText = rec.payload
            TEXT_SPOOL_PARTIAL_APPEND -> fullText += rec.payload
            TEXT_SPOOL_SEGMENT_COMMIT -> {
              val obj = JSONObject(rec.payload)
              fullText += obj.optString("text", "")
            }
          }
        }
        return fullText
      } catch (e: TextPipelineException) {
        throw e
      } catch (e: Exception) {
        throw TextPipelineException(
          TextErrorCodes.SPOOL_READ_FAILED,
          "Failed to read text spool for live buffer $bufferId: ${e.message}",
          e,
        )
      }
    }
    throw TextPipelineException(
      TextErrorCodes.SPOOL_UNAVAILABLE,
      "Text spool files are missing for live buffer: $bufferId"
    )
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
        File("${spoolPath}.txtj").delete()
      } catch (_: Exception) {
      }
      try {
        File("${spoolPath}.txtc").delete()
      } catch (_: Exception) {
      }
    }

    cursors.clear()
    appendListeners.clear()
    commitListeners.clear()
    SegmentationEngineRegistry.onBufferReleased(bufferId)
  }
}

private class TextSpoolWriter(filePath: String) {
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

  fun appendRawRecord(header: ByteArray, payload: ByteArray) {
    synchronized(lock) {
      if (closed) throw IOException("Text spool writer is closed")
      raf.seek(raf.length())
      raf.write(header)
      raf.write(payload)
      bytesWritten = raf.length()
    }
  }

  fun truncate() {
    synchronized(lock) {
      if (closed) return
      raf.setLength(0L)
      raf.seek(0L)
      bytesWritten = 0L
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
  private const val TEXT_SPOOL_MAGIC = 0x32545854 // TXT2
  private const val TEXT_SPOOL_VERSION = 2
  private const val TEXT_SPOOL_CHECKPOINT = 4

  data class JournalRecord(val type: Int, val payload: String)

  fun readCheckpoint(filePath: String): String? {
    val file = File(filePath)
    if (!file.exists()) return null
    RandomAccessFile(file, "r").use { raf ->
      if (raf.length() < 16) throw TextPipelineException(TextErrorCodes.SPOOL_CORRUPTED, "Corrupted text checkpoint header in $filePath")
      val header = ByteArray(16)
      raf.readFully(header)
      val bb = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN)
      val magic = bb.int
      val version = bb.short.toInt()
      val type = bb.short.toInt()
      val length = bb.int
      val checksum = bb.int
      if (magic != TEXT_SPOOL_MAGIC || version != TEXT_SPOOL_VERSION || type != TEXT_SPOOL_CHECKPOINT || length < 0) {
        throw TextPipelineException(TextErrorCodes.SPOOL_CORRUPTED, "Unexpected text checkpoint format in $filePath")
      }
      val payload = ByteArray(length)
      if (length > 0) raf.readFully(payload)
      val actual = CRC32().apply { update(payload) }.value.toInt()
      if (actual != checksum) throw TextPipelineException(TextErrorCodes.SPOOL_CORRUPTED, "Text checkpoint checksum mismatch in $filePath")
      return String(payload, StandardCharsets.UTF_8)
    }
  }

  fun readJournal(filePath: String): List<JournalRecord> {
    val file = File(filePath)
    if (!file.exists()) return emptyList()
    RandomAccessFile(file, "r").use { raf ->
      val out = ArrayList<JournalRecord>()
      while (raf.filePointer < raf.length()) {
        if (raf.length() - raf.filePointer < 16) {
          throw TextPipelineException(TextErrorCodes.SPOOL_CORRUPTED, "Corrupted text journal header in $filePath")
        }
        val header = ByteArray(16)
        raf.readFully(header)
        val bb = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN)
        val magic = bb.int
        val version = bb.short.toInt()
        val type = bb.short.toInt()
        val length = bb.int
        val checksum = bb.int
        if (magic != TEXT_SPOOL_MAGIC || version != TEXT_SPOOL_VERSION || length < 0) {
          throw TextPipelineException(TextErrorCodes.SPOOL_CORRUPTED, "Unexpected text journal record format in $filePath")
        }
        val payload = ByteArray(length)
        if (length > 0) raf.readFully(payload)
        val actual = CRC32().apply { update(payload) }.value.toInt()
        if (actual != checksum) {
          throw TextPipelineException(TextErrorCodes.SPOOL_CORRUPTED, "Text journal checksum mismatch in $filePath")
        }
        out.add(JournalRecord(type, String(payload, StandardCharsets.UTF_8)))
      }
      return out
    }
  }
}
