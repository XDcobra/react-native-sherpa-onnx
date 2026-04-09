package com.sherpaonnx.tts.sink

import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile

/** Maximum PCM data size that fits in a RIFF/WAV 32-bit size field (~4 GB). */
private const val WAV_MAX_DATA_BYTES: Long = 0xFFFFFFFFL

internal class TtsStreamingWavSink(
  private val path: String,
  private val sampleRate: Int
) {
  private val file = File(path)
  private val out = FileOutputStream(file)
  private var dataBytes: Long = 0L

  // Reusable conversion buffer; grown as needed to avoid per-chunk allocation.
  private var convBuf = ByteArray(0)

  init {
    // Reserve header; patch sizes in finalizeFile().
    out.write(ByteArray(44))
  }

  fun writeChunk(samples: FloatArray) {
    if (samples.isEmpty()) return
    val needed = samples.size * 2
    if (convBuf.size < needed) {
      convBuf = ByteArray(needed)
    }
    // Write 16-bit PCM little-endian directly into the reusable buffer.
    var idx = 0
    for (f in samples) {
      val s = (f.coerceIn(-1.0f, 1.0f) * 32767.0f).toInt().toShort()
      convBuf[idx++] = (s.toInt() and 0xFF).toByte()
      convBuf[idx++] = ((s.toInt() ushr 8) and 0xFF).toByte()
    }
    out.write(convBuf, 0, needed)
    dataBytes += needed.toLong()
  }

  fun finalizeFile(): Long {
    out.flush()
    out.close()

    val chunkSize = 36L + dataBytes
    if (chunkSize > WAV_MAX_DATA_BYTES || dataBytes > WAV_MAX_DATA_BYTES) {
      throw IllegalStateException(
        "WAV output exceeds 4 GB RIFF size limit (dataBytes=$dataBytes). " +
          "Split the output into smaller files."
      )
    }

    val raf = RandomAccessFile(file, "rw")
    try {
      val channels = 1
      val bitsPerSample = 16
      val byteRate = sampleRate * channels * bitsPerSample / 8
      val blockAlign = channels * bitsPerSample / 8

      raf.seek(0)
      raf.writeBytes("RIFF")
      writeIntLE(raf, chunkSize.toInt())
      raf.writeBytes("WAVE")
      raf.writeBytes("fmt ")
      writeIntLE(raf, 16)
      writeShortLE(raf, 1)
      writeShortLE(raf, channels)
      writeIntLE(raf, sampleRate)
      writeIntLE(raf, byteRate)
      writeShortLE(raf, blockAlign)
      writeShortLE(raf, bitsPerSample)
      raf.writeBytes("data")
      writeIntLE(raf, dataBytes.toInt())
    } finally {
      raf.close()
    }
    return dataBytes
  }

  fun abort(delete: Boolean) {
    try {
      out.flush()
    } catch (_: Throwable) {
    }
    try {
      out.close()
    } catch (_: Throwable) {
    }
    if (delete) {
      try {
        file.delete()
      } catch (_: Throwable) {
      }
    }
  }

  private fun writeIntLE(raf: RandomAccessFile, value: Int) {
    raf.write(value and 0xFF)
    raf.write((value ushr 8) and 0xFF)
    raf.write((value ushr 16) and 0xFF)
    raf.write((value ushr 24) and 0xFF)
  }

  private fun writeShortLE(raf: RandomAccessFile, value: Int) {
    raf.write(value and 0xFF)
    raf.write((value ushr 8) and 0xFF)
  }
}
