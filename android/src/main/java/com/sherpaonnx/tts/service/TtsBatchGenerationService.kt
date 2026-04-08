package com.sherpaonnx.tts.service

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.k2fsa.sherpa.onnx.GenerationConfig
import com.k2fsa.sherpa.onnx.GeneratedAudio
import com.sherpaonnx.SherpaOnnxTextSegmenter
import com.sherpaonnx.tts.config.TtsGenerationOptionsParser
import com.sherpaonnx.tts.core.TtsEngineRepository
import com.sherpaonnx.tts.core.TtsJniCallbackFactory
import com.sherpaonnx.tts.core.dispatchGenerate
import com.sherpaonnx.pcm.PcmPlayerService

internal class TtsBatchGenerationService(
  private val repository: TtsEngineRepository,
  private val exportService: TtsAudioExportService,
  private val pcmPlayerService: PcmPlayerService
) {
  fun generateTts(instanceId: String, text: String, options: ReadableMap?, promise: Promise) {
    try {
      val inst = repository[instanceId] ?: run {
        Log.e("SherpaOnnxTts", "TTS_GENERATE_ERROR: TTS instance not found: $instanceId")
        promise.reject("TTS_GENERATE_ERROR", "TTS instance not found: $instanceId")
        return
      }
      if (!inst.hasEngine()) {
        Log.e("SherpaOnnxTts", "TTS_GENERATE_ERROR: TTS not initialized")
        promise.reject("TTS_GENERATE_ERROR", "TTS not initialized")
        return
      }
      val sid = TtsGenerationOptionsParser.getSid(options)
      val speed = TtsGenerationOptionsParser.getSpeed(options)
      val audio = when {
        TtsGenerationOptionsParser.hasReferenceAudio(options) && (inst.isZipvoice || inst.isPocket) -> {
          if (inst.isZipvoice) {
            val promptText = options!!.getString("referenceText")?.trim().orEmpty()
            if (promptText.isEmpty()) {
              Log.e("SherpaOnnxTts", "TTS_GENERATE_ERROR: Zipvoice voice cloning requires non-empty referenceText")
              promise.reject(
                "TTS_GENERATE_ERROR",
                "Zipvoice voice cloning requires non-empty referenceText (transcript of reference audio)."
              )
              return
            }
          }
          val config = TtsGenerationOptionsParser.parseGenerationConfig(options) ?: GenerationConfig(speed = speed, sid = sid)
          inst.tts!!.generateWithConfig(text, config)
        }
        TtsGenerationOptionsParser.hasReferenceAudio(options) -> {
          Log.e("SherpaOnnxTts", "TTS_GENERATE_ERROR: Reference audio is not supported for this TTS model type")
          promise.reject(
            "TTS_GENERATE_ERROR",
            "Reference audio is only supported for Zipvoice and Pocket TTS."
          )
          return
        }
        inst.isPocket -> {
          Log.e("SherpaOnnxTts", "TTS_GENERATE_ERROR: Pocket TTS requires reference audio for voice cloning")
          promise.reject(
            "TTS_GENERATE_ERROR",
            "Pocket TTS requires reference audio for voice cloning. Pass referenceAudio and referenceSampleRate (> 0) in options."
          )
          return
        }
        else -> inst.dispatchGenerate(text, sid, speed)
          ?: run {
            Log.e("SherpaOnnxTts", "TTS_GENERATE_ERROR: TTS not initialized")
            promise.reject("TTS_GENERATE_ERROR", "TTS not initialized")
            return
          }
      }
      // Sub-plan 01: store PCM in native sink; Sub-plan 02: return metadata only
      synchronized(inst.sinkLock) {
        inst.sink.update(audio.samples, audio.sampleRate)
      }
      val generation = inst.sink.generation.get()
      val map = Arguments.createMap()
      map.putInt("sampleRate", audio.sampleRate)
      map.putInt("numSamples", audio.samples.size)
      map.putDouble("generation", generation.toDouble())
      promise.resolve(map)
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "generateTts error: ${e.message}", e)
      promise.reject("TTS_GENERATE_ERROR", e.message ?: "Failed to generate speech", e)
    }
  }

  fun generateTtsWithTimestamps(instanceId: String, text: String, options: ReadableMap?, promise: Promise) {
    try {
      val inst = repository[instanceId] ?: run {
        Log.e("SherpaOnnxTts", "TTS_GENERATE_ERROR: TTS instance not found: $instanceId")
        promise.reject("TTS_GENERATE_ERROR", "TTS instance not found: $instanceId")
        return
      }
      if (!inst.hasEngine()) {
        Log.e("SherpaOnnxTts", "TTS_GENERATE_ERROR: TTS not initialized")
        promise.reject("TTS_GENERATE_ERROR", "TTS not initialized")
        return
      }

      val exportChunkOnly = TtsGenerationOptionsParser.isExportChunkTimelineOnly(options)
      var subtitleMode = TtsGenerationOptionsParser.getSubtitleMode(options)
      if (exportChunkOnly) {
        subtitleMode = "estimated"
      }
      val subtitleGranularity = TtsGenerationOptionsParser.getSubtitleGranularity(options)
      if (!exportChunkOnly && TtsGenerationOptionsParser.isCharacterGranularityRequested(options) && subtitleMode != "accurate") {
        Log.e(
          "SherpaOnnxTts",
          "TTS_SUBTITLE_ERROR: Character granularity is only supported when subtitleMode is 'accurate'"
        )
        promise.reject(
          "TTS_SUBTITLE_ERROR",
          "Character granularity is only supported when subtitleMode is 'accurate'."
        )
        return
      }

      val sid = TtsGenerationOptionsParser.getSid(options)
      val speed = TtsGenerationOptionsParser.getSpeed(options)
      val sentenceChunkSizes = mutableListOf<Int>()
      val audio: GeneratedAudio = when {
        subtitleMode == "off" || subtitleMode == "proportional" -> {
          when {
            TtsGenerationOptionsParser.hasReferenceAudio(options) && (inst.isZipvoice || inst.isPocket) -> {
              if (inst.isZipvoice) {
                val promptText = options!!.getString("referenceText")?.trim().orEmpty()
                if (promptText.isEmpty()) {
                  Log.e("SherpaOnnxTts", "TTS_GENERATE_ERROR: Zipvoice voice cloning requires non-empty referenceText")
                  promise.reject(
                    "TTS_GENERATE_ERROR",
                    "Zipvoice voice cloning requires non-empty referenceText (transcript of reference audio)."
                  )
                  return
                }
              }
              val config = TtsGenerationOptionsParser.parseGenerationConfig(options) ?: GenerationConfig(speed = speed, sid = sid)
              inst.tts!!.generateWithConfig(text, config)
            }
            TtsGenerationOptionsParser.hasReferenceAudio(options) -> {
              Log.e("SherpaOnnxTts", "TTS_GENERATE_ERROR: Reference audio is not supported for this TTS model type")
              promise.reject(
                "TTS_GENERATE_ERROR",
                "Reference audio is only supported for Zipvoice and Pocket TTS."
              )
              return
            }
            inst.isPocket -> {
              Log.e("SherpaOnnxTts", "TTS_GENERATE_ERROR: Pocket TTS requires reference audio for voice cloning")
              promise.reject(
                "TTS_GENERATE_ERROR",
                "Pocket TTS requires reference audio for voice cloning. Pass referenceAudio and referenceSampleRate (> 0) in options."
              )
              return
            }
            else -> inst.dispatchGenerate(text, sid, speed)
              ?: run {
                Log.e("SherpaOnnxTts", "TTS_GENERATE_ERROR: TTS not initialized")
                promise.reject("TTS_GENERATE_ERROR", "TTS not initialized")
                return
              }
          }
        }
        TtsGenerationOptionsParser.hasReferenceAudio(options) && (inst.isZipvoice || inst.isPocket) -> {
          if (inst.isZipvoice) {
            val promptText = options!!.getString("referenceText")?.trim().orEmpty()
            if (promptText.isEmpty()) {
              Log.e("SherpaOnnxTts", "TTS_GENERATE_ERROR: Zipvoice voice cloning requires non-empty referenceText")
              promise.reject(
                "TTS_GENERATE_ERROR",
                "Zipvoice voice cloning requires non-empty referenceText (transcript of reference audio)."
              )
              return
            }
          }
          val config = TtsGenerationOptionsParser.parseGenerationConfig(options) ?: GenerationConfig(speed = speed, sid = sid)
          inst.tts!!.generateWithConfigAndCallback(
            text,
            config,
            TtsJniCallbackFactory.ttsChunkCallbackForJni(sentenceChunkSizes)
          )
        }
        TtsGenerationOptionsParser.hasReferenceAudio(options) -> {
          Log.e("SherpaOnnxTts", "TTS_GENERATE_ERROR: Reference audio is not supported for this TTS model type")
          promise.reject(
            "TTS_GENERATE_ERROR",
            "Reference audio is only supported for Zipvoice and Pocket TTS."
          )
          return
        }
        inst.isPocket -> {
          Log.e("SherpaOnnxTts", "TTS_GENERATE_ERROR: Pocket TTS requires reference audio for voice cloning")
          promise.reject(
            "TTS_GENERATE_ERROR",
            "Pocket TTS requires reference audio for voice cloning. Pass referenceAudio and referenceSampleRate (> 0) in options."
          )
          return
        }
        else -> {
          val tts = inst.tts
          if (tts == null) {
            Log.e("SherpaOnnxTts", "TTS_GENERATE_ERROR: TTS not initialized")
            promise.reject("TTS_GENERATE_ERROR", "TTS not initialized")
            return
          }
          tts.generateWithCallback(text, sid, speed, TtsJniCallbackFactory.ttsChunkCallbackForJni(sentenceChunkSizes))
        }
      }

      if (subtitleMode != "off" && sentenceChunkSizes.isEmpty() && audio.samples.isNotEmpty()) {
        sentenceChunkSizes.add(audio.samples.size)
      }

      // Sub-plan 01: store PCM in native sink
      synchronized(inst.sinkLock) {
        inst.sink.update(audio.samples, audio.sampleRate)
      }
      val generation = inst.sink.generation.get()

      // Sub-plan 02: metadata-only — no samples array over the bridge
      val map = Arguments.createMap()
      map.putInt("sampleRate", audio.sampleRate)
      map.putInt("numSamples", audio.samples.size)
      map.putDouble("generation", generation.toDouble())

      if (exportChunkOnly) {
        val counts = Arguments.createArray()
        for (c in sentenceChunkSizes) {
          counts.pushInt(c)
        }
        map.putArray("segmentSampleCounts", counts)
        map.putArray("subtitles", Arguments.createArray())
        map.putString("timingMode", "estimated")
        promise.resolve(map)
        return
      }

      val subtitleItems = if (subtitleMode == "off") {
        emptyList()
      } else {
        val sentenceSegments = SherpaOnnxTextSegmenter.splitIntoSentences(text)
        if (subtitleGranularity == "word") {
          SherpaOnnxTextSegmenter.buildWordSubtitlesFromSentenceChunks(
            sentenceSegments,
            sentenceChunkSizes,
            audio.sampleRate
          )
        } else {
          SherpaOnnxTextSegmenter.buildSubtitlesFromChunks(
            sentenceSegments,
            sentenceChunkSizes,
            audio.sampleRate
          )
        }
      }

      map.putArray("subtitles", TtsGenerationOptionsParser.toSubtitleWritableArray(subtitleItems))
      val timingMode = if (subtitleMode == "off") "off" else "estimated"
      map.putString("timingMode", timingMode)
      promise.resolve(map)
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "TTS_GENERATE_ERROR: ${e.message ?: "Failed to generate speech"}", e)
      promise.reject("TTS_GENERATE_ERROR", e.message ?: "Failed to generate speech", e)
    }
  }

  /**
   * Return PCM samples from the native sink as a number[] for the given generation.
   * This is the fallback path (non-JSI); a future JSI path can return Float32Array directly.
   */
  fun getTtsSamples(instanceId: String, generation: Double, promise: Promise) {
    try {
      val inst = repository[instanceId] ?: run {
        promise.reject("TTS_INSTANCE_NOT_FOUND", "TTS instance not found: $instanceId")
        return
      }
      val requestedGen = generation.toLong()
      synchronized(inst.sinkLock) {
        val currentGen = inst.sink.generation.get()
        if (currentGen == 0L || inst.sink.samples == null) {
          promise.reject("TTS_NO_SAMPLES", "No batch synthesis result available for instance $instanceId")
          return
        }
        if (requestedGen != currentGen) {
          promise.reject("TTS_STALE_GENERATION", "Generation $requestedGen is stale; current is $currentGen")
          return
        }
        val pcm = inst.sink.samples!!
        val arr = Arguments.createArray()
        for (s in pcm) {
          arr.pushDouble(s.toDouble())
        }
        val map = Arguments.createMap()
        map.putArray("samples", arr)
        map.putInt("sampleRate", inst.sink.sampleRate)
        promise.resolve(map)
      }
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "getTtsSamples error: ${e.message}", e)
      promise.reject("TTS_SAMPLES_ERROR", e.message ?: "Failed to get TTS samples", e)
    }
  }

  /**
   * Save audio directly from native sink to file (no JS PCM round-trip).
   */
  fun saveTtsAudioFromSink(
    instanceId: String,
    generation: Double,
    destinationType: String,
    pathOrDirectoryUri: String,
    filename: String,
    format: String,
    outputSampleRateHz: Double,
    promise: Promise
  ) {
    try {
      val inst = repository[instanceId] ?: run {
        promise.reject("TTS_INSTANCE_NOT_FOUND", "TTS instance not found: $instanceId")
        return
      }
      val requestedGen = generation.toLong()
      val pcmCopy: FloatArray
      val rate: Int
      synchronized(inst.sinkLock) {
        val currentGen = inst.sink.generation.get()
        if (currentGen == 0L || inst.sink.samples == null) {
          promise.reject("TTS_NO_SAMPLES", "No batch synthesis result available for instance $instanceId")
          return
        }
        if (requestedGen != currentGen) {
          promise.reject("TTS_STALE_GENERATION", "Generation $requestedGen is stale; current is $currentGen")
          return
        }
        pcmCopy = inst.sink.samples!!.copyOf()
        rate = inst.sink.sampleRate
      }
      // Delegate directly with FloatArray — no ReadableArray conversion needed
      exportService.saveTtsAudioDirect(pcmCopy, rate, destinationType, pathOrDirectoryUri, filename, format, outputSampleRateHz.toInt(), promise)
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "saveTtsAudioFromSink error: ${e.message}", e)
      promise.reject("TTS_SAVE_ERROR", e.message ?: "Failed to save TTS audio from sink", e)
    }
  }

  fun playTtsFromSink(instanceId: String, generation: Double, sampleRate: Double, promise: Promise) {
    try {
      val inst = repository[instanceId] ?: run {
        promise.reject("TTS_INSTANCE_NOT_FOUND", "TTS instance not found: $instanceId")
        return
      }
      val requestedGen = generation.toLong()
      val pcmCopy: FloatArray
      val rate: Int
      synchronized(inst.sinkLock) {
        val currentGen = inst.sink.generation.get()
        if (currentGen == 0L || inst.sink.samples == null) {
          promise.reject("TTS_SINK_EMPTY", "No batch synthesis result available for instance $instanceId")
          return
        }
        if (requestedGen != currentGen) {
          promise.reject("TTS_SINK_STALE", "Generation $requestedGen is stale; current is $currentGen")
          return
        }
        pcmCopy = inst.sink.samples!!.copyOf()
        rate = if (sampleRate.toInt() > 0) sampleRate.toInt() else inst.sink.sampleRate
      }
      val playerId = "batch_play_${instanceId}_${requestedGen}"
      // Auto-destroy any previous batch playback player for this instance
      val prevPlayerId = inst.batchPlaybackPlayerId
      if (prevPlayerId != null) {
        pcmPlayerService.destroyInternal(prevPlayerId)
      }
      inst.batchPlaybackPlayerId = playerId
      pcmPlayerService.createInternal(playerId, rate, 1, instanceId)
      pcmPlayerService.enqueueFromNative(playerId, pcmCopy)
      val result = Arguments.createMap()
      result.putString("playerId", playerId)
      promise.resolve(result)
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "playTtsFromSink error: ${e.message}", e)
      promise.reject("TTS_PLAY_ERROR", e.message ?: "Failed to play TTS audio from sink", e)
    }
  }
}
