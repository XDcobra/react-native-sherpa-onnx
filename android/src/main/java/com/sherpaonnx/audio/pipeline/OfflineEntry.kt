package com.sherpaonnx.audio.pipeline

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap

/**
 * Offline audio buffer entry in the pipeline registry.
 * Immutable once created. Two backing strategies:
 * - InMemory: FloatArray in heap (small files, samples from JS, ring snapshots)
 * - FileBacked: WAV file on disk, read via streaming chunks (large files)
 */
sealed class OfflineEntry {
  abstract val bufferId: String
  abstract val sampleRate: Int
  abstract val channelCount: Int
  abstract val numSamples: Int
  val kind: String = "offlinePcmBuffer"
  val durationMs: Double get() = if (sampleRate > 0) (numSamples.toDouble() / sampleRate) * 1000.0 else 0.0

  fun toWritableMap(): WritableMap {
    val map = Arguments.createMap()
    map.putString("bufferId", bufferId)
    map.putString("kind", kind)
    map.putString("state", "immutable")
    map.putDouble("sampleRate", sampleRate.toDouble())
    map.putInt("channelCount", channelCount)
    map.putInt("numSamples", numSamples)
    map.putDouble("durationMs", durationMs)
    return map
  }

  /**
   * In-memory buffer. All samples are held in a FloatArray on the heap.
   * Suitable for small to medium audio (< ~10 MB PCM).
   *
   * For empty buffers created as output targets (e.g. TTS), [samples] starts as an empty array
   * and is filled exactly once via [adoptSamples].
   */
  class InMemory(
    override val bufferId: String,
    override val sampleRate: Int,
    override val channelCount: Int,
    @Volatile var samples: FloatArray
  ) : OfflineEntry() {
    override val numSamples: Int get() = samples.size

    /**
     * Adopt (move) samples into this buffer. Only allowed once on an empty buffer.
     * @throws IllegalStateException if the buffer is already populated (non-empty).
     */
    @Synchronized
    fun adoptSamples(pcm: FloatArray) {
      if (samples.isNotEmpty()) throw IllegalStateException("OfflineEntry already populated: $bufferId")
      samples = pcm
    }

    /**
     * Try to adopt samples into this buffer atomically.
     * Returns true if adoption succeeded (buffer was empty); false if already populated.
     * Avoids TOCTOU races between check and write.
     */
    @Synchronized
    fun tryAdoptSamples(pcm: FloatArray): Boolean {
      if (samples.isNotEmpty()) return false
      samples = pcm
      return true
    }
  }

  /**
   * File-backed buffer. Samples remain on disk; metadata is parsed from the WAV header.
   * Consumers read via [FileBackedReader] in chunks, never loading the full file.
   */
  class FileBacked(
    override val bufferId: String,
    override val sampleRate: Int,
    override val channelCount: Int,
    val filePath: String,
    val metadata: FileBackedMetadata
  ) : OfflineEntry() {
    override val numSamples: Int get() = metadata.numSamples
  }

  /**
   * Read all samples as FloatArray. For InMemory this is a direct reference;
   * for FileBacked this loads the entire file into memory (use with caution on large files).
   */
  fun readAllSamples(): FloatArray {
    return when (this) {
      is InMemory -> samples
      is FileBacked -> {
        val result = FloatArray(metadata.numSamples)
        FileBackedReader(filePath, metadata).use { reader ->
          var offset = 0
          val chunk = 8192
          while (offset < result.size) {
            val read = reader.readSamples(result, offset, minOf(chunk, result.size - offset))
            if (read <= 0) break
            offset += read
          }
        }
        result
      }
    }
  }

  /**
   * Create a streaming reader for this buffer.
   * For InMemory returns a wrapper around the array; for FileBacked returns a file reader.
   */
  fun createReader(): OfflineReader {
    return when (this) {
      is InMemory -> InMemoryReader(samples)
      is FileBacked -> FileBackedReaderAdapter(filePath, metadata)
    }
  }

  /** Save buffer contents as 16-bit PCM WAV. */
  fun saveToWav(outputPath: String) {
    when (this) {
      is InMemory -> WavWriter.writeFloat32AsInt16Wav(samples, sampleRate, outputPath)
      is FileBacked -> WavWriter.copyFileBackedToInt16Wav(filePath, metadata, outputPath)
    }
  }
}

/**
 * Uniform reader interface for OfflineEntry consumers.
 */
interface OfflineReader : java.io.Closeable {
  /** Read up to [maxSamples] into [out] at [offset]. Returns samples read, 0 at end. */
  fun readSamples(out: FloatArray, offset: Int, maxSamples: Int): Int
  fun seekToSample(sampleIndex: Int)
}

internal class InMemoryReader(private val samples: FloatArray) : OfflineReader {
  private var pos = 0
  override fun readSamples(out: FloatArray, offset: Int, maxSamples: Int): Int {
    if (pos >= samples.size) return 0
    val count = minOf(maxSamples, samples.size - pos)
    System.arraycopy(samples, pos, out, offset, count)
    pos += count
    return count
  }
  override fun seekToSample(sampleIndex: Int) {
    pos = sampleIndex.coerceIn(0, samples.size)
  }
  override fun close() { /* no-op */ }
}

internal class FileBackedReaderAdapter(
  filePath: String,
  metadata: FileBackedMetadata
) : OfflineReader {
  private val reader = FileBackedReader(filePath, metadata)
  override fun readSamples(out: FloatArray, offset: Int, maxSamples: Int) = reader.readSamples(out, offset, maxSamples)
  override fun seekToSample(sampleIndex: Int) = reader.seekToSample(sampleIndex)
  override fun close() = reader.close()
}
