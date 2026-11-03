package com.sherpaonnx.audio.pipeline

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import java.io.Closeable

/**
 * Thin handle over shared C++ PaOfflineEntry (no Kotlin PCM SoT).
 * InMemory / MmapBacked names preserved for existing `when` / type checks.
 */
sealed class OfflineEntry : Closeable {
  abstract val bufferId: String
  abstract val sampleRate: Int
  abstract val channelCount: Int
  abstract val numSamples: Int
  abstract val storageKind: String

  val kind: String = "offlinePcmBuffer"
  val durationMs: Double
    get() = if (sampleRate > 0) (numSamples.toDouble() / sampleRate) * 1000.0 else 0.0

  fun toWritableMap(): WritableMap {
    val map = Arguments.createMap()
    map.putString("bufferId", bufferId)
    map.putString("kind", kind)
    map.putString("state", "immutable")
    map.putInt("sampleRate", sampleRate)
    map.putInt("channelCount", channelCount)
    map.putInt("numSamples", numSamples)
    map.putDouble("durationMs", durationMs)
    map.putString("storageKind", storageKind)
    return map
  }

  fun readAllSamples(): FloatArray =
    AudioBufferNative.nativeReadAllOfflineSamples(bufferId) ?: FloatArray(0)

  fun readSlice(startSample: Int, count: Int): FloatArray =
    AudioBufferNative.nativeReadOfflineSlice(bufferId, startSample, count) ?: FloatArray(0)

  /** Copy offline samples into [out] at [outOffset]; returns samples written (RAM or mmap). */
  fun readInto(startSample: Int, out: FloatArray, outOffset: Int, maxSamples: Int): Int {
    if (maxSamples <= 0 || outOffset < 0 || outOffset >= out.size) return 0
    return AudioBufferNative.nativeReadOfflineInto(
      bufferId,
      startSample,
      out,
      outOffset,
      maxSamples,
    )
  }

  fun releaseResources() {
    AudioBufferNative.nativeRelease(bufferId)
  }

  fun tryAdoptSamples(samples: FloatArray): Boolean =
    AudioBufferNative.nativeAdoptIfEmpty(bufferId, samples)

  fun adoptSamples(pcm: FloatArray) {
    if (!tryAdoptSamples(pcm)) {
      throw IllegalStateException("Cannot adopt samples into $bufferId")
    }
  }

  fun createReader(): OfflineReader = NativeOfflineReader(this)

  override fun close() = releaseResources()

  /**
   * Compatibility alias for empty/output buffers and small RAM buffers.
   * [samples] materializes from C (remaining FloatArray copy path).
   */
  class InMemory(
    override val bufferId: String,
    override val sampleRate: Int,
    override val channelCount: Int,
  ) : OfflineEntry() {
    override val numSamples: Int
      get() = AudioBufferNative.nativeOfflineNumSamples(bufferId).coerceAtLeast(0)

    override val storageKind: String = "ram"

    val samples: FloatArray
      get() = readAllSamples()
  }

  /** Compatibility alias for file-backed / mmap offline buffers. */
  class MmapBacked(
    override val bufferId: String,
    override val sampleRate: Int,
    override val channelCount: Int,
    val filePath: String = "",
  ) : OfflineEntry() {
    override val numSamples: Int
      get() = AudioBufferNative.nativeOfflineNumSamples(bufferId).coerceAtLeast(0)

    override val storageKind: String = "mmap"
  }

  companion object {
    fun wrap(bufferId: String): OfflineEntry? {
      if (!AudioBufferNative.nativeIsOffline(bufferId)) return null
      val sr = AudioBufferNative.nativeOfflineSampleRate(bufferId)
      if (sr <= 0) return null
      val kind = AudioBufferNative.nativeOfflineStorageKind(bufferId) ?: "ram"
      val path = AudioBufferNative.nativeOfflineFilePath(bufferId) ?: ""
      return if (kind == "mmap" || path.isNotEmpty()) {
        MmapBacked(bufferId, sr, 1, path)
      } else {
        InMemory(bufferId, sr, 1)
      }
    }
  }
}

interface OfflineReader : Closeable {
  fun readSamples(out: FloatArray, offset: Int, maxSamples: Int): Int
  fun seekToSample(sampleIndex: Int)
}

typealias CloseableSampleReader = OfflineReader

private class NativeOfflineReader(private val entry: OfflineEntry) : OfflineReader {
  private var pos = 0

  override fun readSamples(out: FloatArray, offset: Int, maxSamples: Int): Int {
    if (pos >= entry.numSamples || maxSamples <= 0 || offset < 0 || offset >= out.size) return 0
    val n = AudioBufferNative.nativeReadOfflineInto(entry.bufferId, pos, out, offset, maxSamples)
    pos += n
    return n
  }

  override fun seekToSample(sampleIndex: Int) {
    pos = sampleIndex.coerceIn(0, entry.numSamples)
  }

  override fun close() { /* no-op */ }
}
