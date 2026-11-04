package com.sherpaonnx.stt.pipeline

import com.sherpaonnx.lifecycle.NativeInstanceGate
import com.sherpaonnx.livePipeline.CommittedSegmentRef
import com.sherpaonnx.livePipeline.OfflineLivePipelineWorker
import com.sherpaonnx.stt.facade.SherpaOnnxSttHelper
import com.sherpaonnx.text.pipeline.LiveTextEntry

internal class SttOfflineLivePipelineWorker(
  pipelineId: String,
  attachedSegmentationEngineId: String,
  private val audioInputRef: AudioInput,
  private val instanceId: String,
  private val sttHelper: SherpaOnnxSttHelper,
  private val textOutputEntry: LiveTextEntry,
) : OfflineLivePipelineWorker(
  pipelineId = pipelineId,
  attachedSegmentationEngineId = attachedSegmentationEngineId,
  audioInput = audioInputRef,
  textInput = null,
) {

  private val gateKey = "stt:$instanceId"

  override fun onSegmentCommitted(segment: CommittedSegmentRef) {
    val speech = segment as? CommittedSegmentRef.Speech ?: return
    val frameCount = (speech.endSample - speech.startSample).coerceAtLeast(0)
    if (frameCount == 0) return

    if (!NativeInstanceGate.beginUse(gateKey)) return

    try {
      val samples = audioInputRef.liveAudioEntry.getSamplesSlice(
        startFrame = speech.startSample,
        frameCount = frameCount,
      )
      if (samples.isEmpty()) return
      val result = sttHelper.transcribeSamplesInternal(instanceId, samples, speech.sampleRate)

      textOutputEntry.commitSegment(
        text = result.text,
        tokens = result.tokens,
        timestamps = result.timestamps,
        source = "segmentation_engine",
      )
      addUnitsWritten(result.text.length.toLong())
    } finally {
      NativeInstanceGate.endUse(gateKey)
    }
  }
}
