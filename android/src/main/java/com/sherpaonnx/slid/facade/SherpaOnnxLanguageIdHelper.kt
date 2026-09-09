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
import com.sherpaonnx.segment.pipeline.SegmentPipelineRegistry
import com.sherpaonnx.segment.pipeline.SegmentRecord
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

  fun getInstance(instanceId: String): SpokenLanguageIdentification? =
    instances[instanceId]

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
    startSample: Double?,
    endSample: Double?,
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

    val hasStart = startSample != null
    val hasEnd = endSample != null
    if (hasStart != hasEnd) {
      promise.reject(
        LanguageIdErrorCodes.INVALID_ARGUMENT,
        "startSample and endSample must both be provided or both omitted"
      )
      return
    }

    executor.execute {
      var stream: OfflineStream? = null
      try {
        val t0 = SystemClock.uptimeMillis()
        val sampleRate = audioEntry.sampleRate
        val samples: FloatArray
        if (!hasStart) {
          samples = audioEntry.readAllSamples()
        } else {
          val start = kotlin.math.floor(startSample!!).toInt().coerceAtLeast(0)
          val endRaw = kotlin.math.floor(endSample!!).toInt().coerceAtLeast(start)
          val end = endRaw.coerceAtMost(audioEntry.numSamples)
          val frameCount = (end - start).coerceAtLeast(0)
          if (frameCount == 0) {
            val result = Arguments.createMap()
            result.putString("lang", "")
            result.putDouble("audioDuration", 0.0)
            result.putDouble("elapsedMs", 0.0)
            promise.resolve(result)
            return@execute
          }
          samples = audioEntry.readSlice(start, frameCount)
        }
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

  fun labelLanguageIdOfflineSegments(
    instanceId: String,
    audioInId: String,
    segmentsInId: String,
    segmentsOutId: String,
    promise: Promise
  ) {
    if (instanceId.isBlank()) {
      promise.reject(LanguageIdErrorCodes.INIT_ERROR, "instanceId is required")
      return
    }
    val slid = instances[instanceId]
    if (slid == null) {
      promise.reject(LanguageIdErrorCodes.NOT_INITIALIZED, "SLID instance not found: $instanceId")
      return
    }

    if (audioInId.isBlank() || !audioInId.startsWith("off_")) {
      promise.reject(
        LanguageIdErrorCodes.INVALID_ARGUMENT,
        "Expected offline audio buffer (off_*), got: $audioInId"
      )
      return
    }
    val audioInEntry = PipelineAudioRegistry.getOffline(audioInId)
    if (audioInEntry == null) {
      promise.reject(
        LanguageIdErrorCodes.BUFFER_NOT_FOUND,
        "Offline audio buffer not found: $audioInId"
      )
      return
    }
    if (audioInEntry.numSamples <= 0 || audioInEntry.sampleRate <= 0) {
      promise.reject(
        LanguageIdErrorCodes.BUFFER_EMPTY,
        "Offline audio buffer is empty: $audioInId"
      )
      return
    }

    if (segmentsInId.isBlank() || !segmentsInId.startsWith("seg_off_")) {
      promise.reject(
        LanguageIdErrorCodes.INVALID_ARGUMENT,
        "Expected offline segment buffer (seg_off_*) for segmentsIn, got: $segmentsInId"
      )
      return
    }
    val segmentsInEntry = SegmentPipelineRegistry.getOffline(segmentsInId)
    if (segmentsInEntry == null) {
      promise.reject(
        LanguageIdErrorCodes.BUFFER_NOT_FOUND,
        "Offline segment buffer not found: $segmentsInId"
      )
      return
    }

    if (segmentsOutId.isBlank() || !segmentsOutId.startsWith("seg_off_")) {
      promise.reject(
        LanguageIdErrorCodes.INVALID_ARGUMENT,
        "Expected offline segment buffer (seg_off_*) for segmentsOut, got: $segmentsOutId"
      )
      return
    }
    val segmentsOutEntry = SegmentPipelineRegistry.getOffline(segmentsOutId)
    if (segmentsOutEntry == null) {
      promise.reject(
        LanguageIdErrorCodes.BUFFER_NOT_FOUND,
        "Offline segment buffer not found: $segmentsOutId"
      )
      return
    }
    if (segmentsOutEntry.snapshotSegments().isNotEmpty()) {
      promise.reject(
        LanguageIdErrorCodes.INVALID_ARGUMENT,
        "segmentsOut must be an empty offline segment buffer: $segmentsOutId"
      )
      return
    }

    executor.execute {
      try {
        val sampleRate = audioInEntry.sampleRate
        val allSegments = segmentsInEntry.snapshotSegments()
        val speechSpans = allSegments.filter { it.kind == "speech" && it.endSample > it.startSample }

        if (speechSpans.isEmpty()) {
          segmentsOutEntry.populate(emptyList())
          val emptyResult = Arguments.createMap()
          emptyResult.putInt("labeledCount", 0)
          emptyResult.putString("dominantLanguage", "")
          emptyResult.putMap("distribution", Arguments.createMap())
          emptyResult.putArray("switches", Arguments.createArray())
          emptyResult.putArray("segments", Arguments.createArray())
          promise.resolve(emptyResult)
          return@execute
        }

        val records = ArrayList<SegmentRecord>(speechSpans.size)
        val segmentsArray = Arguments.createArray()
        val switchesArray = Arguments.createArray()
        val durationByLang = HashMap<String, Double>()
        var totalSpeechDurationMs = 0.0
        var previousLang: String? = null

        for (i in speechSpans.indices) {
          val span = speechSpans[i]
          val frameCount = (span.endSample - span.startSample).coerceAtLeast(0)
          val samples = audioInEntry.readSlice(span.startSample, frameCount)

          var stream: OfflineStream? = null
          val lang: String
          try {
            stream = slid.createStream()
            stream.acceptWaveform(samples, sampleRate)
            lang = slid.compute(stream).trim()
          } finally {
            try {
              stream?.release()
            } catch (_: Exception) {}
          }

          val durationMs = if (span.durationMs > 0) span.durationMs else {
            if (sampleRate > 0) ((span.endSample - span.startSample) * 1000) / sampleRate else 0
          }
          val startTime = if (sampleRate > 0) span.startSample.toDouble() / sampleRate.toDouble() else 0.0
          val endTime = if (sampleRate > 0) span.endSample.toDouble() / sampleRate.toDouble() else 0.0

          records.add(
            SegmentRecord(
              id = span.id,
              kind = "speech",
              sourceAudioBufferId = audioInId,
              startSample = span.startSample,
              endSample = span.endSample,
              sampleRate = span.sampleRate,
              durationMs = durationMs,
              confidence = span.confidence,
              payloadJson = "{\"source\":\"languageId\",\"lang\":\"$lang\"}"
            )
          )

          val segMap = Arguments.createMap()
          segMap.putInt("segmentIndex", i)
          segMap.putDouble("startTime", startTime)
          segMap.putDouble("endTime", endTime)
          segMap.putInt("durationMs", durationMs)
          segMap.putString("lang", lang)
          segmentsArray.pushMap(segMap)

          if (lang.isNotEmpty()) {
            val dur = durationMs.toDouble()
            durationByLang[lang] = (durationByLang[lang] ?: 0.0) + dur
            totalSpeechDurationMs += dur

            if (previousLang == null || lang != previousLang) {
              val switchMap = Arguments.createMap()
              switchMap.putDouble("timestamp", startTime)
              if (previousLang == null) {
                switchMap.putNull("from")
              } else {
                switchMap.putString("from", previousLang)
              }
              switchMap.putString("to", lang)
              switchMap.putInt("segmentIndex", i)
              switchesArray.pushMap(switchMap)
              previousLang = lang
            }
          }
        }

        segmentsOutEntry.populate(records)

        var dominantLanguage = ""
        var maxDuration = -1.0
        val distMap = Arguments.createMap()
        if (totalSpeechDurationMs > 0) {
          for ((l, dur) in durationByLang) {
            if (dur > maxDuration) {
              maxDuration = dur
              dominantLanguage = l
            }
            val fraction = Math.round((dur / totalSpeechDurationMs) * 10000.0) / 10000.0
            distMap.putDouble(l, fraction)
          }
        }

        val result = Arguments.createMap()
        result.putInt("labeledCount", records.size)
        result.putString("dominantLanguage", dominantLanguage)
        result.putMap("distribution", distMap)
        result.putArray("switches", switchesArray)
        result.putArray("segments", segmentsArray)
        promise.resolve(result)
      } catch (e: OutOfMemoryError) {
        Log.e(LanguageIdErrorCodes.TAG, "OOM during language identification labeling", e)
        promise.reject(
          LanguageIdErrorCodes.OFFLINE_OOM,
          OfflineOomError.message("spoken-language-identification"),
          e
        )
      } catch (e: Exception) {
        Log.e(LanguageIdErrorCodes.TAG, "Language identification labeling failed", e)
        promise.reject(
          LanguageIdErrorCodes.IDENTIFY_FAILED,
          "Language identification labeling failed: ${e.message}",
          e
        )
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
