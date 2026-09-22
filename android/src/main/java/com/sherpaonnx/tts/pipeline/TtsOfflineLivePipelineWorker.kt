package com.sherpaonnx.tts.pipeline

import com.k2fsa.sherpa.onnx.GenerationConfig
import com.sherpaonnx.audio.pipeline.LiveAppendOrigin
import com.sherpaonnx.audio.pipeline.LiveAudioPipelineWriter
import com.sherpaonnx.audio.pipeline.LiveEntry
import com.sherpaonnx.livePipeline.CommittedSegmentRef
import com.sherpaonnx.livePipeline.OfflineLivePipelineWorker
import com.sherpaonnx.lifecycle.NativeInstanceGate
import com.sherpaonnx.tts.core.TtsEngineInstance

/**
 * TTS offline live pipeline worker.
 *
 * Extends [OfflineLivePipelineWorker] — all generic pipeline plumbing (threading, cursor
 * management, segmentation-engine drain, flush/stop/completion) is handled by the base class.
 * This class only implements [onSegmentCommitted]: given a committed text segment, it calls
 * the offline TTS engine (batch `generate`) and appends the resulting PCM to the live audio
 * output buffer.
 *
 * Preserves per-segment sid/speed resolution and voice cloning behavior while using
 * the simpler batch-generate API (no streaming callback), because each
 * committed segment is already bounded in length by the segmentation policy.
 *
 * See: docs/migration/liveOverload/sub-05-tts-live-overload.md
 * See: docs/migration/liveOverload/offline-stt-live-pipeline-mandatory-segmentation.md
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
  /** When set (and no [voiceClone]), use GenerationConfig.numSteps for non-clone models. */
  private val defaultNumSteps: Int? = null,
  private val voiceClone: TtsVoiceCloneConfig? = null,
) : OfflineLivePipelineWorker(
  pipelineId = pipelineId,
  attachedSegmentationEngineId = attachedSegmentationEngineId,
  audioInput = null,
  textInput = textInput,
) {

  override fun onSegmentCommitted(segment: CommittedSegmentRef) {
    val text = segment as? CommittedSegmentRef.Text ?: return
    if (text.text.isBlank()) return

    val effectiveSid = (text.meta?.get("sid") as? Number)?.toInt() ?: defaultSid
    val effectiveSpeed = (text.meta?.get("speed") as? Number)?.toFloat() ?: defaultSpeed

    val tts = ttsInstance.tts ?: return
    val gateKey = NativeInstanceGate.keyFor(tts)
    if (!NativeInstanceGate.beginUse(gateKey)) return

    val audio = try {
      when {
        voiceClone != null -> {
          val config = GenerationConfig(
            sid = effectiveSid,
            speed = effectiveSpeed,
            referenceAudio = voiceClone.referenceAudio,
            referenceSampleRate = voiceClone.referenceSampleRate,
            referenceText = voiceClone.referenceText,
            silenceScale = voiceClone.silenceScale,
            numSteps = voiceClone.numSteps,
          )
          tts.generateWithConfig(text.text, config)
        }
        defaultNumSteps != null -> {
          val extra =
            if (!defaultLang.isNullOrBlank()) mapOf("lang" to defaultLang) else null
          val config = GenerationConfig(
            sid = effectiveSid,
            speed = effectiveSpeed,
            numSteps = defaultNumSteps,
            extra = extra,
          )
          tts.generateWithConfig(text.text, config)
        }
        !defaultLang.isNullOrBlank() -> {
          val config = GenerationConfig(
            sid = effectiveSid,
            speed = effectiveSpeed,
            extra = mapOf("lang" to defaultLang),
          )
          tts.generateWithConfig(text.text, config)
        }
        else -> tts.generate(text.text, effectiveSid, effectiveSpeed)
      }
    } finally {
      NativeInstanceGate.endUse(gateKey)
    }

    if (audio.samples.isNotEmpty()) {
      val result = audioOutputEntry.tryAppendSamples(
        audio.samples,
        audio.sampleRate,
        LiveAppendOrigin.Pipeline(LiveAudioPipelineWriter.TTS),
      )
      if (result == com.sherpaonnx.audio.pipeline.LiveEntry.AppendResult.BUFFER_FINALIZED) {
        stop()
        return
      }
      if (result == com.sherpaonnx.audio.pipeline.LiveEntry.AppendResult.APPENDED) {
        addUnitsWritten(audio.samples.size.toLong())
      }
    }
  }
}
