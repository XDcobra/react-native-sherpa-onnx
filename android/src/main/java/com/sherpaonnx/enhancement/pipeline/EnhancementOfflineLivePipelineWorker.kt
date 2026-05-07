package com.sherpaonnx.enhancement.pipeline

import com.k2fsa.sherpa.onnx.OfflineSpeechDenoiser
import com.sherpaonnx.audio.pipeline.LiveEntry
import com.sherpaonnx.livePipeline.CommittedSegmentRef
import com.sherpaonnx.livePipeline.OfflineLivePipelineWorker

internal class EnhancementOfflineLivePipelineWorker(
  pipelineId: String,
  attachedSegmentationEngineId: String,
  private val audioInputRef: AudioInput,
  private val enhancer: OfflineSpeechDenoiser,
  private val audioOutputEntry: LiveEntry,
) : OfflineLivePipelineWorker(
  pipelineId = pipelineId,
  attachedSegmentationEngineId = attachedSegmentationEngineId,
  audioInput = audioInputRef,
  textInput = null,
) {
  override fun onSegmentCommitted(segment: CommittedSegmentRef) {
    val speech = segment as? CommittedSegmentRef.Speech
      ?: error("Expected speech segment in enhancement live overload")

    require(audioOutputEntry.sampleRate == speech.sampleRate) {
      "ENHANCEMENT_SAMPLE_RATE_MISMATCH: live audio out is ${audioOutputEntry.sampleRate} Hz; chunk is ${speech.sampleRate} Hz"
    }

    val frameCount = (speech.endSample - speech.startSample).coerceAtLeast(0)
    if (frameCount == 0) return

    val pcm = audioInputRef.liveAudioEntry.getSamplesSlice(
      startFrame = speech.startSample,
      frameCount = frameCount,
    )
    if (pcm.isEmpty()) return

    val denoised = enhancer.run(pcm, speech.sampleRate)
    if (denoised.samples.isNotEmpty()) {
      val result = audioOutputEntry.tryAppendSamples(
        samples = denoised.samples,
        inputSampleRate = speech.sampleRate,
        source = com.sherpaonnx.audio.pipeline.LIVE_APPEND_SOURCE_ENHANCEMENT
      )
      if (result == com.sherpaonnx.audio.pipeline.LiveEntry.AppendResult.BUFFER_FINALIZED) {
        stop()
        return
      }
      if (result == com.sherpaonnx.audio.pipeline.LiveEntry.AppendResult.APPENDED) {
        addUnitsWritten(denoised.samples.size.toLong())
      }
    }
  }
}
