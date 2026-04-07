package com.sherpaonnx.tts.core

import android.media.AudioTrack
import com.k2fsa.sherpa.onnx.OfflineTts
import java.util.concurrent.atomic.AtomicBoolean

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

internal class TtsEngineInstance(
  @Volatile var tts: OfflineTts? = null,
  @Volatile var ttsInitState: TtsInitState? = null,
  val ttsStreamRunning: AtomicBoolean = AtomicBoolean(false),
  val ttsStreamCancelled: AtomicBoolean = AtomicBoolean(false),
  var ttsStreamThread: Thread? = null,
  var ttsPcmTrack: AudioTrack? = null
) {
  private val lock = Any()

  fun hasEngine(): Boolean = synchronized(lock) { tts != null }
  val isZipvoice: Boolean get() = ttsInitState?.modelType == "zipvoice"
  val isPocket: Boolean get() = ttsInitState?.modelType == "pocket"

  fun releaseEngines() {
    synchronized(lock) {
      tts?.release()
      tts = null
      ttsInitState = null
    }
  }

  fun stopPcmPlayer() {
    synchronized(lock) {
      ttsPcmTrack?.apply {
        try {
          stop()
        } catch (_: IllegalStateException) {
        }
        flush()
        release()
      }
      ttsPcmTrack = null
    }
  }
}

internal fun TtsEngineInstance.dispatchGenerate(text: String, sid: Int, speed: Float) =
  tts?.generate(text, sid, speed)

internal fun TtsEngineInstance.dispatchSampleRate(): Int = tts?.sampleRate() ?: 0

internal fun TtsEngineInstance.dispatchNumSpeakers(): Int = tts?.numSpeakers() ?: 0
