package com.sherpaonnx.segment.pipeline

import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.StandardCharsets

internal class SegmentSpoolWriter(filePath: String) {
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
  }

  fun appendSnapshot(snapshotJson: String) {
    val payload = snapshotJson.toByteArray(StandardCharsets.UTF_8)
    val header = ByteBuffer
      .allocate(RECORD_HEADER_BYTES)
      .order(ByteOrder.LITTLE_ENDIAN)
      .putInt(payload.size)
      .array()

    synchronized(lock) {
      if (closed) throw IOException("Segment spool writer closed")
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

internal object SegmentSpoolReader {
  private const val RECORD_HEADER_BYTES = 4

  fun readLatestSnapshot(path: String): String {
    val file = File(path)
    if (!file.exists()) {
      throw SegmentPipelineException(
        SegmentErrorCodes.SPOOL_UNAVAILABLE,
        "Segment spool file does not exist: $path"
      )
    }

    RandomAccessFile(file, "r").use { raf ->
      val fileLength = raf.length()
      if (fileLength < RECORD_HEADER_BYTES) {
        throw SegmentPipelineException(
          SegmentErrorCodes.SPOOL_CORRUPTED,
          "Corrupted segment spool header: $path"
        )
      }
      raf.seek(0L)
      val header = ByteArray(RECORD_HEADER_BYTES)
      raf.readFully(header)
      val len = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN).int
      if (len < 0) {
        throw SegmentPipelineException(
          SegmentErrorCodes.SPOOL_CORRUPTED,
          "Corrupted segment spool length: $path"
        )
      }
      val expectedLength = RECORD_HEADER_BYTES + len.toLong()
      if (fileLength != expectedLength) {
        throw SegmentPipelineException(
          SegmentErrorCodes.SPOOL_CORRUPTED,
          "Unexpected segment spool size: $path"
        )
      }
      val payload = ByteArray(len)
      if (len > 0) raf.readFully(payload)
      return String(payload, StandardCharsets.UTF_8)
    }
  }
}
