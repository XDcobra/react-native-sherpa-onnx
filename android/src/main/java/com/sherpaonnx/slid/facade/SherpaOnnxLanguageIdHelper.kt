package com.sherpaonnx.slid.facade

import android.os.SystemClock
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.k2fsa.sherpa.onnx.OfflineStream
import com.k2fsa.sherpa.onnx.SpokenLanguageIdentification
import com.k2fsa.sherpa.onnx.SpokenLanguageIdentificationConfig
import com.k2fsa.sherpa.onnx.SpokenLanguageIdentificationWhisperConfig
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.errors.OfflineOomError
import com.sherpaonnx.slid.core.LanguageIdErrorCodes
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

internal class SherpaOnnxLanguageIdHelper {
  private val executor = Executors.newSingleThreadExecutor()
  private val instances = ConcurrentHashMap<String, SpokenLanguageIdentification>()

  fun shutdown() {
    executor.shutdownNow()
    for ((_, instance) in instances) {
      try {
        instance.release()
      } catch (e: Exception) {
        Log.w(LanguageIdErrorCodes.TAG, "Error releasing SLID instance during shutdown: ${e.message}")
      }
    }
    instances.clear()
  }

  fun initializeLanguageId(
    instanceId: String,
    options: ReadableMap,
    promise: Promise
  ) {
    if (instanceId.isBlank()) {
      promise.reject(LanguageIdErrorCodes.INIT_ERROR, "instanceId is required")
      return
    }

    val encoder = if (options.hasKey("encoder")) options.getString("encoder") ?: "" else ""
    val decoder = if (options.hasKey("decoder")) options.getString("decoder") ?: "" else ""

    if (encoder.isBlank()) {
      promise.reject(LanguageIdErrorCodes.INIT_ERROR, "encoder path is required")
      return
    }
    if (decoder.isBlank()) {
      promise.reject(LanguageIdErrorCodes.INIT_ERROR, "decoder path is required")
      return
    }

    val tailPaddings = if (options.hasKey("tailPaddings")) options.getInt("tailPaddings") else -1
    val numThreads = if (options.hasKey("numThreads")) options.getInt("numThreads") else 1
    val provider = if (options.hasKey("provider")) options.getString("provider") ?: "cpu" else "cpu"
    val debug = if (options.hasKey("debug")) options.getBoolean("debug") else false

    executor.execute {
      try {
        instances.remove(instanceId)?.let { old ->
          try {
            old.release()
          } catch (_: Exception) {}
        }

        val whisperConfig = SpokenLanguageIdentificationWhisperConfig(
          encoder = encoder,
          decoder = decoder,
          tailPaddings = tailPaddings,
        )
        val config = SpokenLanguageIdentificationConfig(
          whisper = whisperConfig,
          numThreads = numThreads,
          debug = debug,
          provider = provider,
        )

        val slid = SpokenLanguageIdentification(config = config)
        instances[instanceId] = slid

        val result = Arguments.createMap()
        result.putBoolean("success", true)
        promise.resolve(result)
      } catch (e: OutOfMemoryError) {
        Log.e(LanguageIdErrorCodes.TAG, "OOM initializing SLID", e)
        promise.reject(
          LanguageIdErrorCodes.OFFLINE_OOM,
          OfflineOomError.message("spoken-language-identification"),
          e
        )
      } catch (e: Exception) {
        Log.e(LanguageIdErrorCodes.TAG, "Failed to initialize SLID", e)
        promise.reject(
          LanguageIdErrorCodes.INIT_ERROR,
          "Failed to initialize SLID: ${e.message}",
          e
        )
      }
    }
  }

  fun identifyLanguageOffline(
    instanceId: String,
    audioBufferId: String,
    promise: Promise
  ) {
    val slid = instances[instanceId]
    if (slid == null) {
      promise.reject(LanguageIdErrorCodes.NOT_INITIALIZED, "SLID instance not found: $instanceId")
      return
    }

    val audioEntry = PipelineAudioRegistry.getOffline(audioBufferId)
    if (audioEntry == null) {
      promise.reject(
        LanguageIdErrorCodes.BUFFER_NOT_FOUND,
        "Offline audio buffer not found: $audioBufferId"
      )
      return
    }

    if (audioEntry.numSamples == 0) {
      promise.reject(
        LanguageIdErrorCodes.BUFFER_EMPTY,
        "Offline audio buffer is empty: $audioBufferId"
      )
      return
    }

    executor.execute {
      var stream: OfflineStream? = null
      try {
        val t0 = SystemClock.uptimeMillis()
        val samples = audioEntry.readAllSamples()
        val sampleRate = audioEntry.sampleRate
        val audioDuration = if (sampleRate > 0) samples.size.toDouble() / sampleRate.toDouble() else 0.0

        stream = slid.createStream()
        stream.acceptWaveform(samples, sampleRate)

        val lang = slid.compute(stream)
        val elapsedMs = (SystemClock.uptimeMillis() - t0).toDouble()

        val result = Arguments.createMap()
        result.putString("lang", lang)
        result.putDouble("audioDuration", audioDuration)
        result.putDouble("elapsedMs", elapsedMs)
        promise.resolve(result)
      } catch (e: OutOfMemoryError) {
        Log.e(LanguageIdErrorCodes.TAG, "OOM during language identification", e)
        promise.reject(
          LanguageIdErrorCodes.OFFLINE_OOM,
          OfflineOomError.message("spoken-language-identification"),
          e
        )
      } catch (e: Exception) {
        Log.e(LanguageIdErrorCodes.TAG, "Language identification failed", e)
        promise.reject(
          LanguageIdErrorCodes.IDENTIFY_FAILED,
          "Language identification failed: ${e.message}",
          e
        )
      } finally {
        try {
          stream?.release()
        } catch (_: Exception) {}
      }
    }
  }

  fun unloadLanguageId(
    instanceId: String,
    promise: Promise
  ) {
    executor.execute {
      try {
        val slid = instances.remove(instanceId)
        slid?.release()
        promise.resolve(null)
      } catch (e: Exception) {
        Log.w(LanguageIdErrorCodes.TAG, "Error unloading SLID instance: ${e.message}", e)
        promise.resolve(null)
      }
    }
  }
}
