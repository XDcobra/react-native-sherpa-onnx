package com.sherpaonnx.stt.facade

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
import com.sherpaonnx.stt.pipeline.SttOfflineLivePipelineWorker
import com.sherpaonnx.text.pipeline.TextPipelineRegistry

internal class SherpaOnnxOfflineSttLivePipelineHelper(
  private val context: ReactApplicationContext,
  private val sttHelper: SherpaOnnxSttHelper,
  private val logTag: String,
) {

  fun startSttOfflineLivePipeline(
    instanceId: String,
    audioInLiveBufferId: String,
    textOutLiveBufferId: String,
    options: ReadableMap,
    promise: Promise,
  ) {
    try {
      val recognizer = sttHelper.getRecognizer(instanceId)
      if (recognizer == null) {
        promise.reject("STT_INSTANCE_NOT_FOUND", "Offline STT instance not found: $instanceId")
        return
      }

      val audioEntry = PipelineAudioRegistry.getLive(audioInLiveBufferId)
      if (audioEntry == null) {
        promise.reject("STT_PIPELINE_AUDIO_BUFFER_NOT_FOUND", "Input live audio buffer not found: $audioInLiveBufferId")
        return
      }

      val textEntry = TextPipelineRegistry.getLive(textOutLiveBufferId)
      if (textEntry == null) {
        promise.reject("STT_PIPELINE_TEXT_BUFFER_NOT_FOUND", "Output live text buffer not found: $textOutLiveBufferId")
        return
      }

      val attachedSegmentationEngineId = options.getString("attachedSegmentationEngineId")?.trim().orEmpty()
      if (attachedSegmentationEngineId.isEmpty()) {
        promise.reject("STT_INVALID_ARGUMENT", "attachedSegmentationEngineId is required")
        return
      }

      val segmentLiveBufferId = options.getString("segmentLiveBufferId")?.trim().orEmpty()
      if (segmentLiveBufferId.isEmpty()) {
        promise.reject("STT_INVALID_ARGUMENT", "segmentLiveBufferId is required")
        return
      }

      val segmentEntry = SegmentPipelineRegistry.getLive(segmentLiveBufferId)
      if (segmentEntry == null) {
        promise.reject("STT_PIPELINE_SEGMENT_BUFFER_NOT_FOUND", "Input live segment buffer not found: $segmentLiveBufferId")
        return
      }

      val chunkSize = if (options.hasKey("chunkSize")) {
        options.getDouble("chunkSize").toInt()
      } else {
        3200
      }

      val worker = SttOfflineLivePipelineWorker(
        pipelineId = java.util.UUID.randomUUID().toString(),
        attachedSegmentationEngineId = attachedSegmentationEngineId,
        audioInputRef = OfflineLivePipelineWorker.AudioInput(
          liveAudioEntry = audioEntry,
          liveSegmentEntry = segmentEntry,
        ),
        recognizer = recognizer,
        textOutputEntry = textEntry,
        chunkSize = chunkSize,
      )

      val pipelineId = StreamingPipelineRegistry.registerAndStart(worker) { completion ->
        emitPipelineCompletedEvent(completion)
      }

      val out = Arguments.createMap()
      out.putString("pipelineId", pipelineId)
      promise.resolve(out)
    } catch (e: Exception) {
      Log.e(logTag, "startSttOfflineLivePipeline failed: ${e.message}", e)
      promise.reject("STT_TRANSCRIBE_FAILED", "live offline STT failed: ${e.message}", e)
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
}
