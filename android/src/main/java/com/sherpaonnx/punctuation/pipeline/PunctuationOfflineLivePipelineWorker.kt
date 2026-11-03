package com.sherpaonnx.punctuation.pipeline

import com.sherpaonnx.lifecycle.NativeInstanceGate
import com.sherpaonnx.livePipeline.CommittedSegmentRef
import com.sherpaonnx.livePipeline.OfflineLivePipelineWorker
import com.sherpaonnx.punctuation.core.PunctuationTextInputNormalization
import com.sherpaonnx.punctuation.facade.SherpaOnnxPunctuationHelper
import com.sherpaonnx.text.pipeline.LiveTextEntry

internal class PunctuationOfflineLivePipelineWorker(
  pipelineId: String,
  attachedSegmentationEngineId: String,
  textInput: OfflineLivePipelineWorker.TextInput,
  private val instanceId: String,
  private val textOutputEntry: LiveTextEntry,
  private val textInputNormalization: String = PunctuationTextInputNormalization.DEFAULT_MODE,
) : OfflineLivePipelineWorker(
  pipelineId = pipelineId,
  attachedSegmentationEngineId = attachedSegmentationEngineId,
  audioInput = null,
  textInput = textInput,
) {

  private val gateKey = SherpaOnnxPunctuationHelper.gateKey(instanceId)

  override fun onSegmentCommitted(segment: CommittedSegmentRef) {
    val text = segment as? CommittedSegmentRef.Text ?: return
    if (text.text.isBlank()) return

    if (!NativeInstanceGate.beginUse(gateKey)) return

    val punctuated = try {
      val normalized =
        PunctuationTextInputNormalization.normalize(text.text, textInputNormalization)
      SherpaOnnxPunctuationHelper.addPunctuationOfflineOrThrow(instanceId, normalized)
    } finally {
      NativeInstanceGate.endUse(gateKey)
    }
    textOutputEntry.commitSegment(
      text = punctuated,
      source = "segmentation_engine",
      meta = mapOf("__segmentReason" to "punctuation")
    )
    addUnitsWritten(punctuated.length.toLong())
  }
}
