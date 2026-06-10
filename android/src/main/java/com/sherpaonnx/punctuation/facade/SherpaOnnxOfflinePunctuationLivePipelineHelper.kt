package com.sherpaonnx.punctuation.facade

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.sherpaonnx.audio.pipeline.StreamingPipelineCompletion
import com.sherpaonnx.audio.pipeline.StreamingPipelineRegistry
import com.sherpaonnx.livePipeline.OfflineLivePipelineWorker
import com.sherpaonnx.punctuation.core.PunctuationTextInputNormalization
import com.sherpaonnx.punctuation.pipeline.PunctuationOfflineLivePipelineWorker
import com.sherpaonnx.segment.pipeline.SegmentPipelineRegistry
import com.sherpaonnx.text.pipeline.TextPipelineRegistry

internal class SherpaOnnxOfflinePunctuationLivePipelineHelper(
  private val context: ReactApplicationContext,
  private val punctuationHelper: SherpaOnnxPunctuationHelper,
  private val logTag: String,
) {

  fun startPunctuationOfflineLivePipeline(
    instanceId: String,
    textInLiveBufferId: String,
    textOutLiveBufferId: String,
    options: ReadableMap,
    promise: Promise,
  ) {
    try {
      val punctuator = punctuationHelper.getOfflineEngine(instanceId)
      if (punctuator == null) {
        promise.reject(
          "PUNCTUATION_INSTANCE_NOT_FOUND",
          "Offline punctuation instance not found: $instanceId"
        )
        return
      }

      val textInEntry = TextPipelineRegistry.getLive(textInLiveBufferId)
      if (textInEntry == null) {
        promise.reject(
          "TEXT_BUFFER_NOT_FOUND",
          "Input live text buffer not found: $textInLiveBufferId"
        )
        return
      }

      val textOutEntry = TextPipelineRegistry.getLive(textOutLiveBufferId)
      if (textOutEntry == null) {
        promise.reject(
          "TEXT_BUFFER_NOT_FOUND",
          "Output live text buffer not found: $textOutLiveBufferId"
        )
        return
      }

      val attachedSegmentationEngineId =
        options.getString("attachedSegmentationEngineId")?.trim().orEmpty()
      if (attachedSegmentationEngineId.isEmpty()) {
        promise.reject(
          "PUNCTUATION_INVALID_ARGUMENT",
          "attachedSegmentationEngineId is required"
        )
        return
      }

      val segmentLiveBufferId = options.getString("segmentLiveBufferId")?.trim().orEmpty()
      if (segmentLiveBufferId.isEmpty()) {
        promise.reject(
          "PUNCTUATION_INVALID_ARGUMENT",
          "segmentLiveBufferId is required"
        )
        return
      }

      val segmentEntry = SegmentPipelineRegistry.getLive(segmentLiveBufferId)
      if (segmentEntry == null) {
        promise.reject(
          "SEGMENT_BUFFER_NOT_FOUND",
          "Input live segment buffer not found: $segmentLiveBufferId"
        )
        return
      }

      val textInputNormalization =
        if (options.hasKey("textInputNormalization")) {
          options.getString("textInputNormalization")
        } else {
          null
        }
      val worker = PunctuationOfflineLivePipelineWorker(
        pipelineId = java.util.UUID.randomUUID().toString(),
        attachedSegmentationEngineId = attachedSegmentationEngineId,
        textInput = OfflineLivePipelineWorker.TextInput(
          liveTextEntry = textInEntry,
        ),
        punctuator = punctuator,
        textOutputEntry = textOutEntry,
        textInputNormalization =
          PunctuationTextInputNormalization.resolve(textInputNormalization),
      )

      val pipelineId = StreamingPipelineRegistry.registerAndStart(worker) { completion ->
        emitPipelineCompletedEvent(completion)
      }

      val out = Arguments.createMap()
      out.putString("pipelineId", pipelineId)
      promise.resolve(out)
    } catch (e: Exception) {
      Log.e(logTag, "startPunctuationOfflineLivePipeline failed: ${e.message}", e)
      promise.reject(
        "PUNCTUATION_ERROR",
        "live offline punctuation failed: ${e.message}",
        e
      )
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
