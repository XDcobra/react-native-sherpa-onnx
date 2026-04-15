package com.sherpaonnx.audio.pipeline

import java.io.Closeable
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Metadata for a file-backed offline buffer.
 * Extracted from the WAV header without loading samples into memory.
 */
data class FileBackedMetadata(
  val sampleRate: Int,
  val numSamples: Int,
  val channelCount: Int,
  val bitsPerSample: Int,
  /** audioFormat: 1 = PCM int, 3 = IEEE float */
  val audioFormat: Int,
  /** Byte offset of the first sample in the file (after the WAV header). */
  val dataOffset: Long,
  /** Size of the data chunk in bytes. */
  val dataSize: Long
) {
  val durationMs: Double
    get() = if (sampleRate > 0) (numSamples.toDouble() / sampleRate) * 1000.0 else 0.0
}

/**
 * Parse WAV header and return metadata. Returns null for unsupported formats.
 * Supports: 16-bit PCM mono, 32-bit float mono.
 */
internal fun parseWavHeader(filePath: String): FileBackedMetadata? {
  val f = File(filePath)
  if (!f.isFile || f.length() < 44) return null

  return RandomAccessFile(f, "r").use { raf ->
    val riff = ByteArray(4)
    raf.readFully(riff)
    if (String(riff) != "RIFF") return@use null

    raf.skipBytes(4) // file size
    val wave = ByteArray(4)
    raf.readFully(wave)
    if (String(wave) != "WAVE") return@use null

    var sampleRate = 0
    var channelCount = 0
    var bitsPerSample = 0
    var audioFormat = 0
    var dataOffset = 0L
    var dataSize = 0L

    val idBuf = ByteArray(4)
    val sizeBuf = ByteArray(4)
    while (raf.filePointer <= f.length() - 8) {
      raf.readFully(idBuf)
      raf.readFully(sizeBuf)
      val chunkId = String(idBuf)
      val chunkSize = ByteBuffer.wrap(sizeBuf).order(ByteOrder.LITTLE_ENDIAN).int.toLong() and 0xFFFFFFFFL
      val chunkDataStart = raf.filePointer
      val paddedChunkSize = chunkSize + (chunkSize and 1L)

      when (chunkId) {
        "fmt " -> {
          if (chunkSize < 16) {
            raf.seek(chunkDataStart + paddedChunkSize)
            continue
          }
          val fmt = ByteArray(16)
          raf.readFully(fmt)
          val bb = ByteBuffer.wrap(fmt).order(ByteOrder.LITTLE_ENDIAN)
          audioFormat = bb.short.toInt() and 0xFFFF
          channelCount = bb.short.toInt() and 0xFFFF
          sampleRate = bb.int
          bb.int // byteRate
          bb.short // blockAlign
          bitsPerSample = bb.short.toInt() and 0xFFFF
          raf.seek(chunkDataStart + paddedChunkSize)
        }
        "data" -> {
          dataOffset = raf.filePointer
          dataSize = chunkSize
          break
        }
        else -> {
          raf.seek(chunkDataStart + paddedChunkSize)
        }
      }
    }

    if (dataSize <= 0 || sampleRate <= 0 || channelCount <= 0 || bitsPerSample <= 0) return@use null

    // Supported: PCM 16-bit or IEEE float 32-bit, mono only
    val supported = (audioFormat == 1 && bitsPerSample == 16 && channelCount == 1) ||
      (audioFormat == 3 && bitsPerSample == 32 && channelCount == 1)
    if (!supported) return@use null

    val bytesPerSample = bitsPerSample / 8
    val numSamples = (dataSize / bytesPerSample).toInt()

    FileBackedMetadata(
      sampleRate = sampleRate,
      numSamples = numSamples,
      channelCount = channelCount,
      bitsPerSample = bitsPerSample,
      audioFormat = audioFormat,
      dataOffset = dataOffset,
      dataSize = dataSize
    )
  }
}

/**
 * Streaming reader for file-backed WAV data.
 * Reads samples in chunks without loading the entire file into memory.
 * Always outputs Float32 [-1, 1] regardless of source format.
 */
internal class FileBackedReader(
  filePath: String,
  private val metadata: FileBackedMetadata
) : Closeable {
  private val raf = RandomAccessFile(File(filePath), "r")
  private var currentSample = 0
  private val totalSamples = metadata.numSamples

  init {
    raf.seek(metadata.dataOffset)
  }

  /**
   * Read up to [maxSamples] float samples into [out] starting at [outOffset].
   * Returns the number of samples actually read (0 at EOF).
   */
  fun readSamples(out: FloatArray, outOffset: Int, maxSamples: Int): Int {
    if (currentSample >= totalSamples) return 0
    val toRead = minOf(maxSamples, totalSamples - currentSample)
    if (toRead <= 0) return 0

    when {
      metadata.audioFormat == 1 && metadata.bitsPerSample == 16 -> {
        val bytes = ByteArray(toRead * 2)
        raf.readFully(bytes)
        val bb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        for (i in 0 until toRead) {
          out[outOffset + i] = bb.short.toFloat() / 32768.0f
        }
      }
      metadata.audioFormat == 3 && metadata.bitsPerSample == 32 -> {
        val bytes = ByteArray(toRead * 4)
        raf.readFully(bytes)
        val bb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        for (i in 0 until toRead) {
          out[outOffset + i] = bb.float
        }
      }
    }

    currentSample += toRead
    return toRead
  }

  /** Seek to a specific sample position. */
  fun seekToSample(sampleIndex: Int) {
    val clamped = sampleIndex.coerceIn(0, totalSamples)
    val bytesPerSample = metadata.bitsPerSample / 8
    raf.seek(metadata.dataOffset + clamped.toLong() * bytesPerSample)
    currentSample = clamped
  }

  override fun close() {
    raf.close()
  }
}
