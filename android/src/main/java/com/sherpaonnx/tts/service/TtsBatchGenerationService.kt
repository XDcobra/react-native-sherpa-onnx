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

internal class TtsBatchGenerationService(
  private val repository: TtsEngineRepository
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
      val map = Arguments.createMap()
      val samplesArray = Arguments.createArray()
      for (sample in audio.samples) {
        samplesArray.pushDouble(sample.toDouble())
      }
      map.putArray("samples", samplesArray)
      map.putInt("sampleRate", audio.sampleRate)
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

      val map = Arguments.createMap()
      val samplesArray = Arguments.createArray()
      for (sample in audio.samples) {
        samplesArray.pushDouble(sample.toDouble())
      }
      map.putArray("samples", samplesArray)
      map.putInt("sampleRate", audio.sampleRate)

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
}
