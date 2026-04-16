package com.sherpaonnx.tts.service

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.k2fsa.sherpa.onnx.GenerationConfig
import com.k2fsa.sherpa.onnx.GeneratedAudio
import com.sherpaonnx.tts.config.TtsGenerationOptionsParser
import com.sherpaonnx.tts.core.TtsEngineRepository
import com.sherpaonnx.tts.core.dispatchGenerate
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.audio.pipeline.OfflineEntry
import com.sherpaonnx.errors.OfflineOomError
import com.sherpaonnx.text.pipeline.TextPipelineRegistry

internal class TtsBatchGenerationService(
  private val repository: TtsEngineRepository,
) {

  /**
   * Buffer-to-buffer TTS synthesis: reads text from an OfflineTextBuffer,
   * writes PCM into an empty OfflineAudioBuffer.
   */
  fun synthesizeTts(
    instanceId: String,
    textInBufferId: String,
    audioOutBufferId: String,
    options: ReadableMap?,
    promise: Promise
  ) {
    try {
      // 1. Resolve TTS engine
      val inst = repository[instanceId] ?: run {
        promise.reject("TTS_GENERATE_ERROR", "TTS instance not found: $instanceId")
        return
      }
      if (!inst.hasEngine()) {
        promise.reject("TTS_GENERATE_ERROR", "TTS not initialized")
        return
      }

      // 2. Resolve input text buffer
      val textEntry = TextPipelineRegistry.getOffline(textInBufferId)
      if (textEntry == null) {
        promise.reject("TTS_TEXT_BUFFER_NOT_FOUND", "Offline text buffer not found: $textInBufferId")
        return
      }
      if (!textInBufferId.startsWith("txt_off_")) {
        promise.reject("TTS_TEXT_BUFFER_KIND_MISMATCH", "Expected offline text buffer (txt_off_*), got: $textInBufferId")
        return
      }
      if (!textEntry.populated || textEntry.text.isEmpty()) {
        promise.reject("TTS_TEXT_BUFFER_EMPTY", "Text buffer is empty or not populated: $textInBufferId")
        return
      }

      // 3. Resolve output audio buffer
      val audioEntry = PipelineAudioRegistry.getOffline(audioOutBufferId)
      if (audioEntry == null) {
        promise.reject("TTS_AUDIO_OUT_NOT_FOUND", "Offline audio buffer not found: $audioOutBufferId")
        return
      }
      if (!audioOutBufferId.startsWith("off_")) {
        promise.reject("TTS_AUDIO_OUT_KIND_MISMATCH", "Expected offline audio buffer (off_*), got: $audioOutBufferId")
        return
      }
      if (audioEntry !is OfflineEntry.InMemory) {
        promise.reject("TTS_AUDIO_OUT_KIND_MISMATCH", "Audio output buffer must be an in-memory buffer (created via createEmptyOfflineAudioBuffer)")
        return
      }
      if (audioEntry.numSamples > 0) {
        promise.reject("TTS_AUDIO_OUT_ALREADY_POPULATED", "Audio output buffer is already populated: $audioOutBufferId")
        return
      }

      // 4. Sample rate strict check
      val modelSampleRate = inst.tts?.sampleRate() ?: 0
      if (modelSampleRate > 0 && audioEntry.sampleRate != modelSampleRate) {
        promise.reject(
          "TTS_OUTPUT_SAMPLE_RATE_MISMATCH",
          "audioOut.sampleRate (${audioEntry.sampleRate}) != model sampleRate ($modelSampleRate). " +
            "Allocate with getTtsSampleRate() or tts.getSampleRate()."
        )
        return
      }

      // 5. Parse generation options
      val text = textEntry.text
      val sid = TtsGenerationOptionsParser.getSid(options)
      val speed = TtsGenerationOptionsParser.getSpeed(options)

      // 6. Handle voice cloning with OfflineAudioBuffer reference
      val audio: GeneratedAudio = if (TtsSynthesisOptionsParser.hasVoiceCloneBuffer(options)) {
        if (!inst.isZipvoice && !inst.isPocket) {
          promise.reject("TTS_GENERATE_ERROR", "Reference audio is only supported for Zipvoice and Pocket TTS.")
          return
        }
        val refBufferId = options?.getString("referenceAudioBufferId")
        if (refBufferId.isNullOrEmpty()) {
          promise.reject("TTS_REFERENCE_AUDIO_BUFFER_NOT_FOUND", "referenceAudioBufferId is required for voice cloning")
          return
        }
        val refEntry = PipelineAudioRegistry.getOffline(refBufferId)
        if (refEntry == null) {
          promise.reject("TTS_REFERENCE_AUDIO_BUFFER_NOT_FOUND", "Reference audio buffer not found: $refBufferId")
          return
        }
        if (!refBufferId.startsWith("off_")) {
          promise.reject("TTS_REFERENCE_AUDIO_BUFFER_KIND_MISMATCH", "Expected offline audio buffer for reference, got: $refBufferId")
          return
        }
        if (inst.isZipvoice) {
          val refText = options?.getString("referenceText")?.trim().orEmpty()
          if (refText.isEmpty()) {
            promise.reject("TTS_GENERATE_ERROR", "Zipvoice voice cloning requires non-empty referenceText.")
            return
          }
        }
        // Build GenerationConfig from buffer reference audio
        val refSamples = refEntry.readAllSamples()
        val refSampleRate = refEntry.sampleRate
        val silenceScale = if (options?.hasKey("silenceScale") == true) options.getDouble("silenceScale").toFloat() else 0.2f
        val numSteps = if (options?.hasKey("numSteps") == true) options.getDouble("numSteps").toInt() else 5
        val refText = options?.getString("referenceText") ?: ""
        val extraMap = options?.getMap("extra")?.let { map ->
          val it = map.keySetIterator()
          buildMap<String, String> {
            while (it.hasNextKey()) {
              val k = it.nextKey()
              put(k, map.getString(k).orEmpty())
            }
          }
        }
        val config = GenerationConfig(
          silenceScale = silenceScale,
          speed = speed,
          sid = sid,
          referenceAudio = refSamples,
          referenceSampleRate = refSampleRate,
          referenceText = refText,
          numSteps = numSteps,
          extra = extraMap
        )
        inst.tts!!.generateWithConfig(text, config)
      } else if (inst.isPocket) {
        promise.reject("TTS_GENERATE_ERROR", "Pocket TTS requires reference audio for voice cloning. Pass voiceClone in options.")
        return
      } else {
        inst.dispatchGenerate(text, sid, speed) ?: run {
          promise.reject("TTS_GENERATE_ERROR", "TTS not initialized")
          return
        }
      }

      if (audio.samples.isEmpty() || audio.sampleRate == 0) {
        promise.reject("TTS_GENERATE_ERROR", "TTS generated empty audio")
        return
      }

      // 7. Adopt samples into the output buffer (zero-copy move, synchronized to prevent TOCTOU)
      val adopted = audioEntry.tryAdoptSamples(audio.samples)
      if (!adopted) {
        promise.reject("TTS_AUDIO_OUT_ALREADY_POPULATED", "Audio output buffer was populated concurrently: $audioOutBufferId")
        return
      }

      // Upgrade to mmap if it exceeds the threshold
      PipelineAudioRegistry.upgradeToMmapIfNeeded(audioOutBufferId)

      promise.resolve(null)
    } catch (e: OutOfMemoryError) {
      Log.e("SherpaOnnxTts", "synthesizeTts OOM", e)
      promise.reject(
        OfflineOomError.CODE,
        OfflineOomError.message("text-to-speech"),
        e
      )
    } catch (e: Exception) {
      Log.e("SherpaOnnxTts", "synthesizeTts error: ${e.message}", e)
      promise.reject("TTS_GENERATE_ERROR", e.message ?: "Failed to synthesize speech", e)
    }
  }
}

/**
 * Helper to check for buffer-based voice clone options in the new pipeline API.
 */
internal object TtsSynthesisOptionsParser {
  fun hasVoiceCloneBuffer(options: ReadableMap?): Boolean {
    if (options == null) return false
    return options.hasKey("referenceAudioBufferId") &&
      !options.isNull("referenceAudioBufferId") &&
      (options.getString("referenceAudioBufferId")?.isNotEmpty() == true)
  }
}
