package com.sherpaonnx.segment.pipeline

import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.StandardCharsets
import java.util.zip.CRC32

internal object SegmentSpoolFormat {
  const val MAGIC = 0x32474553 // SEG2 little-endian
  const val VERSION = 2
  const val HEADER_BYTES = 16
  const val RECORD_SEGMENT_APPEND = 1
  const val RECORD_CHECKPOINT_MARK = 2
  const val RECORD_FINALIZE_MARK = 3
  const val CHECKPOINT_EVERY_EVENTS = 128
  const val CHECKPOINT_EVERY_BYTES = 1_048_576L
}

internal data class SegmentJournalRecord(
  val type: Int,
  val payload: String,
)

internal class SegmentJournalWriter(private val filePath: String) {
  companion object {
    private const val HEADER_BYTES = SegmentSpoolFormat.HEADER_BYTES
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
    raf.seek(raf.length())
    bytesWritten = raf.length()
  }

  fun appendRecord(recordType: Int, payloadJson: String) {
    val payload = payloadJson.toByteArray(StandardCharsets.UTF_8)
    val crc = CRC32().apply { update(payload) }.value.toInt()
    val header = ByteBuffer
      .allocate(HEADER_BYTES)
      .order(ByteOrder.LITTLE_ENDIAN)
      .putInt(SegmentSpoolFormat.MAGIC)
      .putShort(SegmentSpoolFormat.VERSION.toShort())
      .putShort(recordType.toShort())
      .putInt(payload.size)
      .putInt(crc)
      .array()

    synchronized(lock) {
      if (closed) throw IOException("Segment journal writer closed")
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

internal object SegmentJournalReader {
  private const val HEADER_BYTES = SegmentSpoolFormat.HEADER_BYTES

  fun readAllRecords(path: String): List<SegmentJournalRecord> {
    val file = File(path)
    if (!file.exists()) {
      return emptyList()
    }

    RandomAccessFile(file, "r").use { raf ->
      val out = ArrayList<SegmentJournalRecord>()
      while (raf.filePointer < raf.length()) {
        val remaining = raf.length() - raf.filePointer
        if (remaining < HEADER_BYTES) {
          throw SegmentPipelineException(
            SegmentErrorCodes.SPOOL_CORRUPTED,
            "Corrupted segment journal header: $path"
          )
        }
        val header = ByteArray(HEADER_BYTES)
        raf.readFully(header)
        val bb = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN)
        val magic = bb.int
        val version = bb.short.toInt()
        val type = bb.short.toInt()
        val len = bb.int
        val crc = bb.int
        if (magic != SegmentSpoolFormat.MAGIC || version != SegmentSpoolFormat.VERSION) {
          throw SegmentPipelineException(
            SegmentErrorCodes.SPOOL_CORRUPTED,
            "Unexpected segment journal record version: $path"
          )
        }
        if (len < 0) {
          throw SegmentPipelineException(
            SegmentErrorCodes.SPOOL_CORRUPTED,
            "Corrupted segment journal record length: $path"
          )
        }
        val payload = ByteArray(len)
        if (len > 0) {
          if (raf.filePointer + len > raf.length()) {
            throw SegmentPipelineException(
              SegmentErrorCodes.SPOOL_CORRUPTED,
              "Truncated segment journal payload: $path"
            )
          }
          raf.readFully(payload)
        }
        val actualCrc = CRC32().apply { update(payload) }.value.toInt()
        if (actualCrc != crc) {
          throw SegmentPipelineException(
            SegmentErrorCodes.SPOOL_CORRUPTED,
            "Segment journal checksum mismatch: $path"
          )
        }
        out.add(SegmentJournalRecord(type, String(payload, StandardCharsets.UTF_8)))
      }
      return out
    }
  }
}

internal class SegmentCheckpointWriter(private val filePath: String) {
  fun writeSnapshot(snapshotJson: String) {
    val tmpPath = "$filePath.tmp"
    val tmpFile = File(tmpPath)
    tmpFile.parentFile?.mkdirs()
    RandomAccessFile(tmpFile, "rw").use { raf ->
      raf.setLength(0L)
      val payload = snapshotJson.toByteArray(StandardCharsets.UTF_8)
      val crc = CRC32().apply { update(payload) }.value.toInt()
      val header = ByteBuffer
        .allocate(SegmentSpoolFormat.HEADER_BYTES)
        .order(ByteOrder.LITTLE_ENDIAN)
        .putInt(SegmentSpoolFormat.MAGIC)
        .putShort(SegmentSpoolFormat.VERSION.toShort())
        .putShort(SegmentSpoolFormat.RECORD_CHECKPOINT_MARK.toShort())
        .putInt(payload.size)
        .putInt(crc)
        .array()
      raf.write(header)
      raf.write(payload)
      raf.fd.sync()
    }
    val target = File(filePath)
    if (target.exists() && !target.delete()) {
      throw SegmentPipelineException(
        SegmentErrorCodes.SPOOL_WRITE_FAILED,
        "Failed to replace checkpoint file: $filePath"
      )
    }
    if (!tmpFile.renameTo(target)) {
      throw SegmentPipelineException(
        SegmentErrorCodes.SPOOL_WRITE_FAILED,
        "Failed to finalize checkpoint file: $filePath"
      )
    }
  }
}

internal object SegmentCheckpointReader {
  fun readSnapshot(path: String): String? {
    val file = File(path)
    if (!file.exists()) return null
    RandomAccessFile(file, "r").use { raf ->
      if (raf.length() < SegmentSpoolFormat.HEADER_BYTES) {
        throw SegmentPipelineException(
          SegmentErrorCodes.SPOOL_CORRUPTED,
          "Corrupted segment checkpoint header: $path"
        )
      }
      val header = ByteArray(SegmentSpoolFormat.HEADER_BYTES)
      raf.readFully(header)
      val bb = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN)
      val magic = bb.int
      val version = bb.short.toInt()
      val type = bb.short.toInt()
      val len = bb.int
      val crc = bb.int
      if (magic != SegmentSpoolFormat.MAGIC || version != SegmentSpoolFormat.VERSION ||
        type != SegmentSpoolFormat.RECORD_CHECKPOINT_MARK || len < 0
      ) {
        throw SegmentPipelineException(
          SegmentErrorCodes.SPOOL_CORRUPTED,
          "Unexpected segment checkpoint record format: $path"
        )
      }
      val payload = ByteArray(len)
      if (len > 0) raf.readFully(payload)
      if (raf.filePointer != raf.length()) {
        throw SegmentPipelineException(
          SegmentErrorCodes.SPOOL_CORRUPTED,
          "Unexpected trailing data in checkpoint file: $path"
        )
      }
      val actualCrc = CRC32().apply { update(payload) }.value.toInt()
      if (actualCrc != crc) {
        throw SegmentPipelineException(
          SegmentErrorCodes.SPOOL_CORRUPTED,
          "Segment checkpoint checksum mismatch: $path"
        )
      }
      return String(payload, StandardCharsets.UTF_8)
    }
  }
}
