package com.sherpaonnx.tts.pipeline

import com.sherpaonnx.audio.pipeline.LiveAppendOrigin
import com.sherpaonnx.audio.pipeline.LiveAudioPipelineWriter
import com.sherpaonnx.audio.pipeline.LiveEntry
import com.sherpaonnx.livePipeline.CommittedSegmentRef
import com.sherpaonnx.livePipeline.OfflineLivePipelineWorker
import com.sherpaonnx.lifecycle.NativeInstanceGate
import com.sherpaonnx.tts.core.TtsEngineInstance
import com.sherpaonnx.tts.nativeapi.TtsNative

/**
 * TTS offline live pipeline worker — batch generate per committed segment via shared CXX.
 */
internal class TtsOfflineLivePipelineWorker(
  pipelineId: String,
  attachedSegmentationEngineId: String,
  textInput: OfflineLivePipelineWorker.TextInput,
  private val ttsInstance: TtsEngineInstance,
  private val audioOutputEntry: LiveEntry,
  private val defaultSid: Int = 0,
  private val defaultSpeed: Float = 1.0f,
  private val defaultLang: String? = null,
  private val defaultNumSteps: Int? = null,
  private val defaultPhonemeCodepoints: Array<IntArray>? = null,
  private val defaultTokens: Array<Array<String>>? = null,
  private val voiceClone: TtsVoiceCloneConfig? = null,
) : OfflineLivePipelineWorker(
  pipelineId = pipelineId,
  attachedSegmentationEngineId = attachedSegmentationEngineId,
  audioInput = null,
  textInput = textInput,
) {

  override fun onSegmentCommitted(segment: CommittedSegmentRef) {
    val text = segment as? CommittedSegmentRef.Text ?: return
    val hasPhonemes =
      defaultPhonemeCodepoints != null ||
        defaultTokens != null ||
        voiceClone?.phonemeCodepoints != null ||
        voiceClone?.tokens != null
    if (text.text.isBlank() && !hasPhonemes) return

    val effectiveSid = (text.meta?.get("sid") as? Number)?.toInt() ?: defaultSid
    val effectiveSpeed = (text.meta?.get("speed") as? Number)?.toFloat() ?: defaultSpeed

    if (!ttsInstance.hasEngine()) return
    val gateKey = ttsInstance.gateKey()
    if (!NativeInstanceGate.beginUse(gateKey)) return

    val audioPair = try {
      when {
        voiceClone != null -> {
          TtsNative.readAudioResult(
            TtsNative.nativeGenerateWithOptions(
              instanceId = ttsInstance.instanceId,
              text = text.text,
              sid = effectiveSid,
              speed = effectiveSpeed,
              applyNumSteps = true,
              numSteps = voiceClone.numSteps,
              silenceScale = voiceClone.silenceScale,
              referenceAudio = null,
              referenceSampleRate = 0,
              referenceText = voiceClone.referenceText,
              referenceBufferId = voiceClone.referenceBufferId,
              extra = null,
              phonemeCodepoints = voiceClone.phonemeCodepoints ?: defaultPhonemeCodepoints,
              tokens = voiceClone.tokens ?: defaultTokens,
            )
          )
        }
        defaultNumSteps != null -> {
          val extra =
            if (!defaultLang.isNullOrBlank()) hashMapOf("lang" to defaultLang) else null
          TtsNative.readAudioResult(
            TtsNative.nativeGenerateWithOptions(
              instanceId = ttsInstance.instanceId,
              text = text.text,
              sid = effectiveSid,
              speed = effectiveSpeed,
              applyNumSteps = true,
              numSteps = defaultNumSteps,
              silenceScale = 0.2f,
              referenceAudio = null,
              referenceSampleRate = 0,
              referenceText = null,
              extra = extra,
              phonemeCodepoints = defaultPhonemeCodepoints,
              tokens = defaultTokens,
            )
          )
        }
        !defaultLang.isNullOrBlank() ||
          defaultPhonemeCodepoints != null ||
          defaultTokens != null -> {
          val extra =
            if (!defaultLang.isNullOrBlank()) hashMapOf("lang" to defaultLang) else null
          TtsNative.readAudioResult(
            TtsNative.nativeGenerateWithOptions(
              instanceId = ttsInstance.instanceId,
              text = text.text,
              sid = effectiveSid,
              speed = effectiveSpeed,
              applyNumSteps = false,
              numSteps = 5,
              silenceScale = 0.2f,
              referenceAudio = null,
              referenceSampleRate = 0,
              referenceText = null,
              extra = extra,
              phonemeCodepoints = defaultPhonemeCodepoints,
              tokens = defaultTokens,
            )
          )
        }
        else -> TtsNative.readAudioResult(
          TtsNative.nativeGenerate(
            ttsInstance.instanceId,
            text.text,
            effectiveSid,
            effectiveSpeed,
          )
        )
      }
    } finally {
      NativeInstanceGate.endUse(gateKey)
    }

    val (samples, sampleRate) = audioPair ?: return
    if (samples.isNotEmpty()) {
      val result = audioOutputEntry.tryAppendSamples(
        samples,
        sampleRate,
        LiveAppendOrigin.Pipeline(LiveAudioPipelineWriter.TTS),
      )
      if (result == com.sherpaonnx.audio.pipeline.LiveEntry.AppendResult.BUFFER_FINALIZED) {
        stop()
        return
      }
      if (result == com.sherpaonnx.audio.pipeline.LiveEntry.AppendResult.APPENDED) {
        addUnitsWritten(samples.size.toLong())
      }
    }
  }
}
