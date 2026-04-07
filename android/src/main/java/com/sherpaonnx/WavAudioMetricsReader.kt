package com.sherpaonnx

import java.io.File
import java.io.RandomAccessFile

/**
 * Reads sample rate and total PCM sample count from a standard **16-bit mono PCM** WAV file without
 * decoding samples. Other WAV variants return null (caller may fall back to full decode).
 */
internal object WavAudioMetricsReader {
  data class Metrics(val sampleRate: Int, val totalSamples: Int)

  fun readMetrics(absolutePath: String): Metrics? {
    val f = File(absolutePath)
    if (!f.isFile || f.length() < 44) {
      return null
    }
    return RandomAccessFile(f, "r").use { raf ->
      if (!readFourCc(raf, "RIFF")) {
        return@use null
      }
      raf.skipBytes(4)
      if (!readFourCc(raf, "WAVE")) {
        return@use null
      }

      var sampleRate = 0
      var blockAlign = 1
      var dataSize = -1L

      while (raf.filePointer <= f.length() - 8) {
        val id = readId(raf) ?: return@use null
        val sz = readLe32(raf).toLong() and 0xFFFFFFFFL
        val chunkDataStart = raf.filePointer
        when (id) {
          "fmt " -> {
            if (sz < 16) {
              skipToNextChunk(raf, chunkDataStart, sz)
              continue
            }
            val audioFormat = readLe16(raf)
            val numChannels = readLe16(raf)
            sampleRate = readLe32(raf)
            raf.skipBytes(4)
            blockAlign = readLe16(raf).coerceAtLeast(1)
            val bitsPerSample = readLe16(raf)
            if (audioFormat != 1 || numChannels != 1 || bitsPerSample != 16) {
              return@use null
            }
            skipToNextChunk(raf, chunkDataStart, sz)
          }
          "data" -> {
            dataSize = sz
            break
          }
          else -> {
            skipToNextChunk(raf, chunkDataStart, sz)
          }
        }
      }

      if (sampleRate <= 0 || dataSize < 0 || blockAlign <= 0) {
        return@use null
      }
      val totalSamples = (dataSize / blockAlign).toInt()
      if (totalSamples < 0) {
        return@use null
      }
      Metrics(sampleRate, totalSamples)
    }
  }

  private fun skipToNextChunk(raf: RandomAccessFile, chunkDataStart: Long, chunkSize: Long) {
    val padded = chunkSize + (chunkSize and 1)
    raf.seek(chunkDataStart + padded)
  }

  private fun readFourCc(raf: RandomAccessFile, expected: String): Boolean {
    val b = ByteArray(4)
    if (raf.read(b) != 4) {
      return false
    }
    return String(b, Charsets.US_ASCII) == expected
  }

  private fun readId(raf: RandomAccessFile): String? {
    val b = ByteArray(4)
    if (raf.read(b) != 4) {
      return null
    }
    return String(b, Charsets.US_ASCII)
  }

  private fun readLe16(raf: RandomAccessFile): Int {
    val b0 = raf.read()
    val b1 = raf.read()
    if (b0 < 0 || b1 < 0) {
      return 0
    }
    return b0 or (b1 shl 8)
  }

  private fun readLe32(raf: RandomAccessFile): Int {
    val b0 = raf.read()
    val b1 = raf.read()
    val b2 = raf.read()
    val b3 = raf.read()
    if (b0 < 0 || b1 < 0 || b2 < 0 || b3 < 0) {
      return 0
    }
    return b0 or (b1 shl 8) or (b2 shl 16) or (b3 shl 24)
  }
}
