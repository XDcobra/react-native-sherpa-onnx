package com.sherpaonnx.speakeridentification.pipeline

import android.util.Log
import com.sherpaonnx.livePipeline.CommittedSegmentRef
import com.sherpaonnx.livePipeline.OfflineLivePipelineWorker
import com.sherpaonnx.segment.pipeline.LiveSegmentEntry
import com.sherpaonnx.speakerembedding.facade.SherpaOnnxSpeakerEmbeddingHelper
import org.json.JSONObject

internal class SpeakerIdentificationOfflineLivePipelineWorker(
  pipelineId: String,
  attachedSegmentationEngineId: String,
  private val audioInputRef: AudioInput,
  private val audioInBufferId: String,
  private val embeddingHelper: SherpaOnnxSpeakerEmbeddingHelper,
  private val instanceId: String,
  private val managerId: String,
  private val threshold: Float,
  private val segmentsOutEntry: LiveSegmentEntry,
) : OfflineLivePipelineWorker(
  pipelineId = pipelineId,
  attachedSegmentationEngineId = attachedSegmentationEngineId,
  audioInput = audioInputRef,
  textInput = null,
) {

  override fun onSegmentCommitted(segment: CommittedSegmentRef) {
    val speech = segment as? CommittedSegmentRef.Speech ?: return
    val frameCount = (speech.endSample - speech.startSample).coerceAtLeast(0)
    if (frameCount == 0) return

    val samples = audioInputRef.liveAudioEntry.getSamplesSlice(
      startFrame = speech.startSample,
      frameCount = frameCount,
    )
    if (samples.isEmpty()) return

    Log.d(
      TAG,
      "label span start=${speech.startSample} end=${speech.endSample} frames=${samples.size} sr=${speech.sampleRate}",
    )

    val embedding = embeddingHelper.computeEmbeddingFromSamples(
      instanceId = instanceId,
      samples = samples,
      sampleRate = speech.sampleRate,
    )
    val matched = embeddingHelper.searchSpeaker(
      managerId = managerId,
      embedding = embedding,
      threshold = threshold,
    ).trim()
    val speakerName = matched.ifEmpty { null }

    Log.d(
      TAG,
      "search result speaker=${speakerName ?: "null"} dim=${embedding.size} threshold=$threshold",
    )

    val payloadJson = JSONObject().apply {
      put("source", "sid")
      if (speakerName == null) {
        put("speakerName", JSONObject.NULL)
      } else {
        put("speakerName", speakerName)
      }
    }.toString()

    val sourceAudioBufferId =
      speech.sourceAudioBufferId.ifBlank { audioInBufferId }

    segmentsOutEntry.appendSegment(
      kind = "speech",
      sourceAudioBufferId = sourceAudioBufferId,
      startSample = speech.startSample,
      endSample = speech.endSample,
      sampleRate = speech.sampleRate,
      durationMs = speech.durationMs,
      confidence = speech.confidence,
      payloadJson = payloadJson,
      forceEmitAppendedEvent = true,
    )
    addUnitsWritten(1)
  }

  companion object {
    private const val TAG = "SherpaOnnx:sid-live"
  }
}
