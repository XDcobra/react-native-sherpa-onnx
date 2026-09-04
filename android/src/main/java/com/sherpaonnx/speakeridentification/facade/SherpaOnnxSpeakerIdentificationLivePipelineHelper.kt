package com.sherpaonnx.speakeridentification.facade

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.audio.pipeline.StreamingPipelineCompletion
import com.sherpaonnx.audio.pipeline.StreamingPipelineRegistry
import com.sherpaonnx.livePipeline.OfflineLivePipelineWorker
import com.sherpaonnx.segment.pipeline.SegmentPipelineRegistry
import com.sherpaonnx.speakerembedding.facade.SherpaOnnxSpeakerEmbeddingHelper
import com.sherpaonnx.speakeridentification.pipeline.SpeakerIdentificationOfflineLivePipelineWorker

internal class SherpaOnnxSpeakerIdentificationLivePipelineHelper(
  private val context: ReactApplicationContext,
  private val embeddingHelper: SherpaOnnxSpeakerEmbeddingHelper,
  private val logTag: String,
) {

  fun startSpeakerIdentificationOfflineLivePipeline(
    instanceId: String,
    managerId: String,
    audioInLiveBufferId: String,
    segmentsOutLiveBufferId: String,
    options: ReadableMap,
    promise: Promise,
  ) {
    try {
      if (instanceId.isBlank()) {
        promise.reject(ERR_INVALID, "instanceId is required")
        return
      }
      if (managerId.isBlank()) {
        promise.reject(ERR_INVALID, "managerId is required")
        return
      }

      val audioEntry = PipelineAudioRegistry.getLive(audioInLiveBufferId)
      if (audioEntry == null) {
        promise.reject(
          ERR_AUDIO_NOT_FOUND,
          "Input live audio buffer not found: $audioInLiveBufferId",
        )
        return
      }

      val segmentsOutEntry = SegmentPipelineRegistry.getLive(segmentsOutLiveBufferId)
      if (segmentsOutEntry == null) {
        promise.reject(
          ERR_SEGMENT_NOT_FOUND,
          "Output live segment buffer not found: $segmentsOutLiveBufferId",
        )
        return
      }

      val attachedSegmentationEngineId =
        options.getString("attachedSegmentationEngineId")?.trim().orEmpty()
      if (attachedSegmentationEngineId.isEmpty()) {
        promise.reject(ERR_INVALID, "attachedSegmentationEngineId is required")
        return
      }

      val segmentLiveBufferId =
        options.getString("segmentLiveBufferId")?.trim().orEmpty()
      if (segmentLiveBufferId.isEmpty()) {
        promise.reject(ERR_INVALID, "segmentLiveBufferId is required")
        return
      }

      val segmentEntry = SegmentPipelineRegistry.getLive(segmentLiveBufferId)
      if (segmentEntry == null) {
        promise.reject(
          ERR_SEGMENT_NOT_FOUND,
          "Input live segment buffer not found: $segmentLiveBufferId",
        )
        return
      }

      if (!options.hasKey("threshold") || options.isNull("threshold")) {
        promise.reject(ERR_INVALID, "threshold is required")
        return
      }
      val threshold = options.getDouble("threshold").toFloat()
      if (!threshold.isFinite()) {
        promise.reject(ERR_INVALID, "threshold must be a finite number")
        return
      }

      val pipelineId = "sid_live_" + java.util.UUID.randomUUID().toString()
      val worker = SpeakerIdentificationOfflineLivePipelineWorker(
        pipelineId = pipelineId,
        attachedSegmentationEngineId = attachedSegmentationEngineId,
        audioInputRef = OfflineLivePipelineWorker.AudioInput(
          liveAudioEntry = audioEntry,
          liveSegmentEntry = segmentEntry,
        ),
        audioInBufferId = audioInLiveBufferId,
        embeddingHelper = embeddingHelper,
        instanceId = instanceId,
        managerId = managerId,
        threshold = threshold,
        segmentsOutEntry = segmentsOutEntry,
      )

      val registeredId = StreamingPipelineRegistry.registerAndStart(worker) { completion ->
        emitPipelineCompletedEvent(completion)
      }

      val out = Arguments.createMap()
      out.putString("pipelineId", registeredId)
      promise.resolve(out)
    } catch (e: Exception) {
      Log.e(logTag, "startSpeakerIdentificationOfflineLivePipeline failed: ${e.message}", e)
      promise.reject(ERR_START_FAILED, "live SID failed: ${e.message}", e)
    }
  }

  private fun emitPipelineCompletedEvent(completion: StreamingPipelineCompletion) {
    try {
      val payload = Arguments.createMap().apply {
        putString("pipelineId", completion.pipelineId)
        putString("reason", completion.reason)
        putDouble("chunksProcessed", completion.chunksProcessed.toDouble())
        putDouble("unitsRead", completion.unitsRead.toDouble())
        putDouble("unitsWritten", completion.unitsWritten.toDouble())
        if (completion.error != null) {
          putString("error", completion.error)
        } else {
          putNull("error")
        }
      }

      context
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("streamingPipelineCompleted", payload)
    } catch (_: Exception) {
      // JS bridge might already be shutting down.
    }
  }

  companion object {
    private const val ERR_INVALID = "SID_INVALID_ARGUMENT"
    private const val ERR_AUDIO_NOT_FOUND = "SID_PIPELINE_AUDIO_BUFFER_NOT_FOUND"
    private const val ERR_SEGMENT_NOT_FOUND = "SID_PIPELINE_SEGMENT_BUFFER_NOT_FOUND"
    private const val ERR_START_FAILED = "SID_LABEL_FAILED"
  }
}
