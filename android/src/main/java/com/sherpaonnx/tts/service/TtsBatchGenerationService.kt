package com.sherpaonnx.tts.service

import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.sherpaonnx.tts.config.TtsGenerationOptionsParser
import com.sherpaonnx.tts.core.TtsEngineRepository
import com.sherpaonnx.tts.nativeapi.TtsNative
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.audio.pipeline.OfflineEntry
import com.sherpaonnx.errors.OfflineOomError
import com.sherpaonnx.lifecycle.NativeInstanceGate
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
      val inst = repository[instanceId] ?: run {
        promise.reject("TTS_GENERATE_ERROR", "TTS instance not found: $instanceId")
        return
      }
      if (!inst.hasEngine()) {
        promise.reject("TTS_GENERATE_ERROR", "TTS not initialized")
        return
      }

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
        if (!TtsGenerationOptionsParser.hasPhonemeInput(options)) {
          promise.reject("TTS_TEXT_BUFFER_EMPTY", "Text buffer is empty or not populated: $textInBufferId")
          return
        }
      }

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

      val modelSampleRate = TtsNative.nativeGetSampleRate(instanceId)
      if (modelSampleRate > 0 && audioEntry.sampleRate != modelSampleRate) {
        promise.reject(
          "TTS_OUTPUT_SAMPLE_RATE_MISMATCH",
          "audioOut.sampleRate (${audioEntry.sampleRate}) != model sampleRate ($modelSampleRate). " +
            "Allocate with getTtsSampleRate() or tts.getSampleRate()."
        )
        return
      }

      if (TtsGenerationOptionsParser.rejectNumStepsIfInvalid(inst, options, promise, "TTS_GENERATE_ERROR")) {
        return
      }

      val text = textEntry.text
      val sid = TtsGenerationOptionsParser.getSid(options)
      val speed = TtsGenerationOptionsParser.getSpeed(options)

      val gateKey = inst.gateKey()
      if (!NativeInstanceGate.beginUse(gateKey)) {
        promise.reject("TTS_GENERATE_ERROR", "TTS instance released: $instanceId")
        return
      }
      val audioPair: Pair<FloatArray, Int> = try {
        if (TtsGenerationOptionsParser.hasVoiceCloneBuffer(options)) {
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
          if (refEntry.numSamples <= 0 || refEntry.sampleRate <= 0) {
            promise.reject("TTS_GENERATE_ERROR", "Reference audio buffer is empty: $refBufferId")
            return
          }
          val silenceScale = TtsGenerationOptionsParser.getSilenceScale(options)
          val numSteps = TtsGenerationOptionsParser.getNumSteps(options)
          val refText = options?.getString("referenceText") ?: ""
          val raw = TtsNative.nativeGenerateWithOptions(
            instanceId = instanceId,
            text = text,
            sid = sid,
            speed = speed,
            applyNumSteps = true,
            numSteps = numSteps,
            silenceScale = silenceScale,
            referenceAudio = null,
            referenceSampleRate = 0,
            referenceText = refText,
            referenceBufferId = refBufferId,
            extra = TtsGenerationOptionsParser.buildExtraMap(options),
            phonemeCodepoints = TtsGenerationOptionsParser.parsePhonemeCodepoints(options),
            tokens = TtsGenerationOptionsParser.parseTokens(options),
          )
          TtsNative.readAudioResult(raw)
            ?: run {
              promise.reject("TTS_GENERATE_ERROR", "TTS generated empty audio")
              return
            }
        } else if (inst.isPocket) {
          promise.reject("TTS_GENERATE_ERROR", "Pocket TTS requires reference audio for voice cloning. Pass voiceClone in options.")
          return
        } else if (TtsGenerationOptionsParser.needsGenerationOptions(options)) {
          val raw = TtsNative.nativeGenerateWithOptions(
            instanceId = instanceId,
            text = text,
            sid = sid,
            speed = speed,
            applyNumSteps = TtsGenerationOptionsParser.hasNumSteps(options),
            numSteps = TtsGenerationOptionsParser.getNumSteps(options),
            silenceScale = TtsGenerationOptionsParser.getSilenceScale(options),
            referenceAudio = null,
            referenceSampleRate = 0,
            referenceText = null,
            extra = TtsGenerationOptionsParser.buildExtraMap(options),
            phonemeCodepoints = TtsGenerationOptionsParser.parsePhonemeCodepoints(options),
            tokens = TtsGenerationOptionsParser.parseTokens(options),
          )
          TtsNative.readAudioResult(raw)
            ?: run {
              promise.reject("TTS_GENERATE_ERROR", "TTS generated empty audio")
              return
            }
        } else {
          val raw = TtsNative.nativeGenerate(instanceId, text, sid, speed)
          TtsNative.readAudioResult(raw)
            ?: run {
              promise.reject("TTS_GENERATE_ERROR", "TTS generated empty audio")
              return
            }
        }
      } finally {
        NativeInstanceGate.endUse(gateKey)
      }

      val (samples, _) = audioPair
      val adopted = audioEntry.tryAdoptSamples(samples)
      if (!adopted) {
        promise.reject("TTS_AUDIO_OUT_ALREADY_POPULATED", "Audio output buffer was populated concurrently: $audioOutBufferId")
        return
      }

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

internal object TtsSynthesisOptionsParser {
  fun hasVoiceCloneBuffer(options: ReadableMap?): Boolean =
    TtsGenerationOptionsParser.hasVoiceCloneBuffer(options)
}
