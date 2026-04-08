package com.sherpaonnx.tts.core

import com.k2fsa.sherpa.onnx.OfflineTts
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

internal data class TtsInitState(
  val modelDir: String,
  val modelType: String,
  val numThreads: Int,
  val debug: Boolean,
  val noiseScale: Double?,
  val noiseScaleW: Double?,
  val lengthScale: Double?,
  val ruleFsts: String?,
  val ruleFars: String?,
  val maxNumSentences: Int?,
  val silenceScale: Double?,
  val provider: String?
)

/**
 * Native PCM sink: holds the last successful batch synthesis result per instance.
 * Thread-safety: all reads/writes must be done under the parent [TtsEngineInstance.sinkLock].
 */
internal class BatchPcmSink {
  var samples: FloatArray? = null
  var sampleRate: Int = 0
  var numSamples: Int = 0
  val generation: AtomicLong = AtomicLong(0)

  /** Replace sink contents after a successful batch generation. */
  fun update(pcm: FloatArray, rate: Int) {
    samples = pcm.copyOf()
    sampleRate = rate
    numSamples = pcm.size
    generation.incrementAndGet()
  }

  /** Clear sink (e.g. on destroy/unload). */
  fun clear() {
    samples = null
    sampleRate = 0
    numSamples = 0
    // generation stays — stale reads will see mismatch
  }
}

internal class TtsEngineInstance(
  @Volatile var tts: OfflineTts? = null,
  @Volatile var ttsInitState: TtsInitState? = null,
  val ttsStreamRunning: AtomicBoolean = AtomicBoolean(false),
  val ttsStreamCancelled: AtomicBoolean = AtomicBoolean(false),
  var ttsStreamThread: Thread? = null
) {
  private val lock = Any()

  /** PCM sink for the last batch synthesis (Sub-plan 01). */
  val sink = BatchPcmSink()
  val sinkLock = Any()

  /** Player ID of the auto-created batch playback player, if any (Sub-plan 04). */
  @Volatile var batchPlaybackPlayerId: String? = null

  fun hasEngine(): Boolean = synchronized(lock) { tts != null }
  val isZipvoice: Boolean get() = ttsInitState?.modelType == "zipvoice"
  val isPocket: Boolean get() = ttsInitState?.modelType == "pocket"

  fun releaseEngines() {
    synchronized(lock) {
      tts?.release()
      tts = null
      ttsInitState = null
    }
    synchronized(sinkLock) {
      sink.clear()
    }
  }
}

internal fun TtsEngineInstance.dispatchGenerate(text: String, sid: Int, speed: Float) =
  tts?.generate(text, sid, speed)

internal fun TtsEngineInstance.dispatchSampleRate(): Int = tts?.sampleRate() ?: 0

internal fun TtsEngineInstance.dispatchNumSpeakers(): Int = tts?.numSpeakers() ?: 0
