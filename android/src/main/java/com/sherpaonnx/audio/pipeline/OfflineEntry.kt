package com.sherpaonnx.audio.pipeline

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.MappedByteBuffer
import java.nio.channels.FileChannel

/** 10 MB raw PCM threshold. Buffers at or above this size use file-backed mmap. */
internal const val PA_FILE_BACKED_THRESHOLD_BYTES: Long = 10L * 1024 * 1024

private const val TAG = "OfflineEntry"

/**
 * Offline audio buffer entry in the pipeline registry.
 * Immutable once created. Two backing strategies:
 * - InMemory: FloatArray in heap (small buffers, < 10 MB raw PCM)
 * - MmapBacked: Raw float32 file on disk, memory-mapped for zero-copy random access (≥ 10 MB)
 */
sealed class OfflineEntry {
  abstract val bufferId: String
  abstract val sampleRate: Int
  abstract val channelCount: Int
  abstract val numSamples: Int
  /** Storage strategy: "ram" for InMemory, "mmap" for MmapBacked. */
  abstract val storageKind: String
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
    map.putString("storageKind", storageKind)
    return map
  }

  /** Release resources (mmap region, temp file). */
  open fun releaseResources() {}

  /** Read all samples as FloatArray. */
  abstract fun readAllSamples(): FloatArray

  /** Read a slice of samples. */
  abstract fun readSlice(startSample: Int, count: Int): FloatArray

  /**
   * In-memory buffer. All samples are held in a FloatArray on the heap.
   * Suitable for small to medium audio (< 10 MB raw PCM).
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
    override val storageKind: String = "ram"

    override fun readAllSamples(): FloatArray = samples

    override fun readSlice(startSample: Int, count: Int): FloatArray {
      val safeStart = startSample.coerceAtLeast(0)
      if (safeStart >= samples.size) return FloatArray(0)
      val endExclusive = (safeStart + count).coerceAtMost(samples.size)
      return samples.copyOfRange(safeStart, endExclusive)
    }

    override fun releaseResources() { samples = FloatArray(0) }

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
     */
    @Synchronized
    fun tryAdoptSamples(pcm: FloatArray): Boolean {
      if (samples.isNotEmpty()) return false
      samples = pcm
      return true
    }
  }

  /**
   * Memory-mapped file-backed buffer. Samples are stored as raw float32 in a temp file
   * and accessed via [MappedByteBuffer] for zero-copy random access.
   * Used for large buffers (≥ 10 MB raw PCM) to reduce heap pressure.
   */
  class MmapBacked(
    override val bufferId: String,
    override val sampleRate: Int,
    override val channelCount: Int,
    override val numSamples: Int,
    val filePath: String,
    @Volatile private var mappedBuffer: MappedByteBuffer?
  ) : OfflineEntry() {
    override val storageKind: String = "mmap"

    override fun readAllSamples(): FloatArray {
      val fb = requireMapping().asFloatBuffer()
      fb.position(0)
      val out = FloatArray(numSamples)
      fb.get(out)
      return out
    }

    override fun readSlice(startSample: Int, count: Int): FloatArray {
      val safeStart = startSample.coerceAtLeast(0)
      if (safeStart >= numSamples) return FloatArray(0)
      val actualCount = (count).coerceAtMost(numSamples - safeStart)
      val fb = requireMapping().asFloatBuffer()
      fb.position(safeStart)
      val out = FloatArray(actualCount)
      fb.get(out)
      return out
    }

    override fun releaseResources() {
      mappedBuffer = null // Release reference → GC will unmap
      try { File(filePath).delete() } catch (_: Exception) {}
    }

    private fun requireMapping(): MappedByteBuffer =
      mappedBuffer ?: throw IllegalStateException("Buffer already released: $bufferId")
  }

  /**
   * Create a streaming reader for this buffer.
   */
  fun createReader(): OfflineReader {
    return when (this) {
      is InMemory -> InMemoryReader(samples)
      is MmapBacked -> MmapReader(this)
    }
  }

  companion object {
    /**
     * Write Float32 samples to a raw .f32 temp file and mmap it.
     * Returns [MmapBacked] entry, or null if writing/mapping fails.
     */
    fun createMmapFromSamples(
      bufferId: String,
      sampleRate: Int,
      channelCount: Int,
      samples: FloatArray,
      cacheDir: File,
    ): MmapBacked? {
      return try {
        val tempFile = File(cacheDir, "pa_off_${bufferId}.f32")
        FileOutputStream(tempFile).use { fos ->
          val buf = ByteBuffer.allocate(samples.size * 4).order(ByteOrder.LITTLE_ENDIAN)
          buf.asFloatBuffer().put(samples)
          fos.write(buf.array())
        }
        val mapped = mapFile(tempFile) ?: run {
          tempFile.delete()
          return null
        }
        MmapBacked(
          bufferId = bufferId,
          sampleRate = sampleRate,
          channelCount = channelCount,
          numSamples = samples.size,
          filePath = tempFile.absolutePath,
          mappedBuffer = mapped,
        )
      } catch (e: Exception) {
        Log.w(TAG, "Failed to create mmap-backed buffer: ${e.message}")
        null
      }
    }

    private fun mapFile(file: File): MappedByteBuffer? {
      return try {
        val raf = RandomAccessFile(file, "r")
        val mapped = raf.channel.map(FileChannel.MapMode.READ_ONLY, 0, file.length())
        mapped.order(ByteOrder.LITTLE_ENDIAN)
        raf.close()
        mapped
      } catch (e: Exception) {
        Log.w(TAG, "Failed to mmap file: ${e.message}")
        null
      }
    }

    /**
     * Adopt an already-written raw float32 file as an mmap-backed entry.
     * The file is memory-mapped directly — no heap allocation of all samples.
     * Used by streaming decode to avoid OOM on large files.
     *
     * @param f32FilePath Absolute path to an existing raw float32 file.
     * @param numSamples Total number of float32 samples in the file.
     * @return [MmapBacked] entry, or null if mapping fails.
     */
    fun createMmapFromFile(
      bufferId: String,
      sampleRate: Int,
      channelCount: Int,
      numSamples: Int,
      f32FilePath: String,
    ): MmapBacked? {
      return try {
        val file = File(f32FilePath)
        if (!file.exists() || file.length() != numSamples.toLong() * 4) {
          Log.w(TAG, "createMmapFromFile: file missing or size mismatch")
          return null
        }
        val mapped = mapFile(file) ?: return null
        MmapBacked(
          bufferId = bufferId,
          sampleRate = sampleRate,
          channelCount = channelCount,
          numSamples = numSamples,
          filePath = f32FilePath,
          mappedBuffer = mapped,
        )
      } catch (e: Exception) {
        Log.w(TAG, "Failed to create mmap-backed buffer from file: ${e.message}")
        null
      }
    }

    /**
     * Sweep orphaned .f32 temp files older than [maxAgeMs] from [cacheDir].
     */
    fun sweepOrphanedTempFiles(cacheDir: File, maxAgeMs: Long = 3_600_000L) {
      try {
        val now = System.currentTimeMillis()
        val files = cacheDir.listFiles { f ->
          f.name.startsWith("pa_off_") && f.name.endsWith(".f32")
        } ?: return
        for (f in files) {
          if (now - f.lastModified() > maxAgeMs) {
            if (f.delete()) {
              Log.d(TAG, "Orphan sweep: deleted ${f.name}")
            }
          }
        }
      } catch (e: Exception) {
        Log.w(TAG, "Orphan sweep failed: ${e.message}")
      }
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

internal class MmapReader(private val entry: OfflineEntry.MmapBacked) : OfflineReader {
  private var pos = 0
  override fun readSamples(out: FloatArray, offset: Int, maxSamples: Int): Int {
    if (pos >= entry.numSamples) return 0
    val count = minOf(maxSamples, entry.numSamples - pos)
    val slice = entry.readSlice(pos, count)
    System.arraycopy(slice, 0, out, offset, slice.size)
    pos += slice.size
    return slice.size
  }
  override fun seekToSample(sampleIndex: Int) {
    pos = sampleIndex.coerceIn(0, entry.numSamples)
  }
  override fun close() { /* no-op */ }
}
