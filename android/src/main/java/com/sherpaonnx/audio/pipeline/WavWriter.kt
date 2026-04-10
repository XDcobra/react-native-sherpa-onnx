package com.sherpaonnx.audio.pipeline

import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Minimal WAV writer for pipeline audio buffers.
 * Writes standard RIFF/WAVE with 16-bit PCM (mono) or 32-bit float (mono).
 * No FFmpeg dependency.
 */
internal object WavWriter {

  /**
   * Write Float32 samples as 16-bit signed PCM WAV (mono).
   * Standard for STT / alignment consumption.
   */
  fun writeFloat32AsInt16Wav(
    samples: FloatArray,
    sampleRate: Int,
    outputPath: String
  ) {
    val numSamples = samples.size
    val dataSize = numSamples * 2 // 16-bit = 2 bytes per sample
    val fileSize = 44 + dataSize // 44-byte header + data
    val file = File(outputPath)
    file.parentFile?.mkdirs()
    RandomAccessFile(file, "rw").use { raf ->
      raf.setLength(0)
      val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
      // RIFF header
      header.put("RIFF".toByteArray(Charsets.US_ASCII))
      header.putInt(fileSize - 8)
      header.put("WAVE".toByteArray(Charsets.US_ASCII))
      // fmt chunk
      header.put("fmt ".toByteArray(Charsets.US_ASCII))
      header.putInt(16)          // chunk size
      header.putShort(1)         // audioFormat = PCM
      header.putShort(1)         // numChannels = mono
      header.putInt(sampleRate)
      header.putInt(sampleRate * 2) // byteRate = sampleRate * blockAlign
      header.putShort(2)         // blockAlign = numChannels * bitsPerSample / 8
      header.putShort(16)        // bitsPerSample
      // data chunk
      header.put("data".toByteArray(Charsets.US_ASCII))
      header.putInt(dataSize)
      raf.write(header.array())

      // Write samples in chunks to avoid large temporary allocations
      val chunkSize = 8192
      val buf = ByteBuffer.allocate(chunkSize * 2).order(ByteOrder.LITTLE_ENDIAN)
      var offset = 0
      while (offset < numSamples) {
        buf.clear()
        val end = minOf(offset + chunkSize, numSamples)
        for (i in offset until end) {
          val clamped = samples[i].coerceIn(-1.0f, 1.0f)
          val s16 = (clamped * 32767.0f).toInt().coerceIn(-32768, 32767).toShort()
          buf.putShort(s16)
        }
        buf.flip()
        raf.write(buf.array(), 0, buf.limit())
        offset = end
      }
    }
  }

  /**
   * Write Float32 samples as 32-bit float PCM WAV (mono).
   * IEEE float format (audioFormat = 3).
   */
  fun writeFloat32Wav(
    samples: FloatArray,
    sampleRate: Int,
    outputPath: String
  ) {
    val numSamples = samples.size
    val dataSize = numSamples * 4 // 32-bit = 4 bytes per sample
    val fileSize = 44 + dataSize
    val file = File(outputPath)
    file.parentFile?.mkdirs()
    RandomAccessFile(file, "rw").use { raf ->
      raf.setLength(0)
      val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
      header.put("RIFF".toByteArray(Charsets.US_ASCII))
      header.putInt(fileSize - 8)
      header.put("WAVE".toByteArray(Charsets.US_ASCII))
      header.put("fmt ".toByteArray(Charsets.US_ASCII))
      header.putInt(16)
      header.putShort(3)         // audioFormat = IEEE float
      header.putShort(1)         // mono
      header.putInt(sampleRate)
      header.putInt(sampleRate * 4) // byteRate
      header.putShort(4)         // blockAlign
      header.putShort(32)        // bitsPerSample
      header.put("data".toByteArray(Charsets.US_ASCII))
      header.putInt(dataSize)
      raf.write(header.array())

      val chunkSize = 8192
      val buf = ByteBuffer.allocate(chunkSize * 4).order(ByteOrder.LITTLE_ENDIAN)
      var offset = 0
      while (offset < numSamples) {
        buf.clear()
        val end = minOf(offset + chunkSize, numSamples)
        for (i in offset until end) {
          buf.putFloat(samples[i])
        }
        buf.flip()
        raf.write(buf.array(), 0, buf.limit())
        offset = end
      }
    }
  }

  /**
   * Stream-read a file-backed WAV and write samples to an output WAV file in chunks.
   * Avoids loading the entire source into memory.
   */
  fun copyFileBackedToInt16Wav(
    sourcePath: String,
    sourceMetadata: FileBackedMetadata,
    outputPath: String
  ) {
    val file = File(outputPath)
    file.parentFile?.mkdirs()

    val numSamples = sourceMetadata.numSamples
    val sampleRate = sourceMetadata.sampleRate
    val dataSize = numSamples * 2
    val fileSize = 44 + dataSize

    RandomAccessFile(file, "rw").use { outRaf ->
      outRaf.setLength(0)

      // Write header (will patch dataSize at end if needed for very large files)
      val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
      header.put("RIFF".toByteArray(Charsets.US_ASCII))
      header.putInt(fileSize - 8)
      header.put("WAVE".toByteArray(Charsets.US_ASCII))
      header.put("fmt ".toByteArray(Charsets.US_ASCII))
      header.putInt(16)
      header.putShort(1) // PCM
      header.putShort(1) // mono
      header.putInt(sampleRate)
      header.putInt(sampleRate * 2)
      header.putShort(2)
      header.putShort(16)
      header.put("data".toByteArray(Charsets.US_ASCII))
      header.putInt(dataSize)
      outRaf.write(header.array())

      // Stream-read source in chunks
      val chunkSamples = 8192
      val chunk = FloatArray(chunkSamples)
      val buf = ByteBuffer.allocate(chunkSamples * 2).order(ByteOrder.LITTLE_ENDIAN)
      val reader = FileBackedReader(sourcePath, sourceMetadata)
      reader.use { r ->
        while (true) {
          val read = r.readSamples(chunk, 0, chunkSamples)
          if (read <= 0) break
          buf.clear()
          for (i in 0 until read) {
            val clamped = chunk[i].coerceIn(-1.0f, 1.0f)
            val s16 = (clamped * 32767.0f).toInt().coerceIn(-32768, 32767).toShort()
            buf.putShort(s16)
          }
          buf.flip()
          outRaf.write(buf.array(), 0, buf.limit())
        }
      }
    }
  }
}
