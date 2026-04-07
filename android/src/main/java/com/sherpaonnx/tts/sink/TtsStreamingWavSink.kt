package com.sherpaonnx.tts.sink

import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

internal class TtsStreamingWavSink(
  private val path: String,
  private val sampleRate: Int
) {
  private val file = File(path)
  private val out = FileOutputStream(file)
  private var dataBytes: Long = 0L

  init {
    // Reserve header; patch sizes in finalizeFile().
    out.write(ByteArray(44))
  }

  fun writeChunk(samples: FloatArray) {
    if (samples.isEmpty()) return
    val bb = ByteBuffer.allocate(samples.size * 2).order(ByteOrder.LITTLE_ENDIAN)
    for (f in samples) {
      val s = (f.coerceIn(-1.0f, 1.0f) * 32767.0f).toInt().toShort()
      bb.putShort(s)
    }
    val bytes = bb.array()
    out.write(bytes)
    dataBytes += bytes.size.toLong()
  }

  fun finalizeFile(): Long {
    out.flush()
    out.close()
    val raf = RandomAccessFile(file, "rw")
    try {
      val channels = 1
      val bitsPerSample = 16
      val byteRate = sampleRate * channels * bitsPerSample / 8
      val blockAlign = channels * bitsPerSample / 8
      val chunkSize = 36L + dataBytes

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
