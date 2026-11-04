package com.sherpaonnx.tts.core

import com.sherpaonnx.lifecycle.NativeInstanceGate
import com.sherpaonnx.tts.nativeapi.TtsNative
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
  val provider: String?,
  val quantization: String? = null,
  val kokoroLang: String? = null,
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
  }
}

internal class TtsEngineInstance(
  val instanceId: String,
  @Volatile var ready: Boolean = false,
  @Volatile var ttsInitState: TtsInitState? = null,
  val ttsStreamRunning: AtomicBoolean = AtomicBoolean(false),
  val ttsStreamCancelled: AtomicBoolean = AtomicBoolean(false),
  var ttsStreamThread: Thread? = null
) {
  /** PCM sink for the last batch synthesis (Sub-plan 01). */
  val sink = BatchPcmSink()
  val sinkLock = Any()

  /** Player ID of the auto-created batch playback player, if any (Sub-plan 04). */
  @Volatile var batchPlaybackPlayerId: String? = null

  fun gateKey(): String = TtsNative.gateKey(instanceId)

  fun hasEngine(): Boolean = ready && TtsNative.nativeHasInstance(instanceId)
  val isZipvoice: Boolean get() = ttsInitState?.modelType == "zipvoice"
  val isPocket: Boolean get() = ttsInitState?.modelType == "pocket"

  fun releaseEngines() {
    val key = gateKey()
    NativeInstanceGate.releaseWhenIdle(key) {
      try {
        TtsNative.nativeUnload(instanceId)
      } catch (_: Exception) {
        // best-effort
      }
    }
    ready = false
    ttsInitState = null
    synchronized(sinkLock) {
      sink.clear()
    }
  }
}

internal fun TtsEngineInstance.dispatchSampleRate(): Int =
  if (hasEngine()) TtsNative.nativeGetSampleRate(instanceId) else 0

internal fun TtsEngineInstance.dispatchNumSpeakers(): Int =
  if (hasEngine()) TtsNative.nativeGetNumSpeakers(instanceId) else 0
