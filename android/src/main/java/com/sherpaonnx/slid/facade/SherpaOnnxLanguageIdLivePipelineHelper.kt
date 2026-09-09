package com.sherpaonnx.slid.facade

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
import com.sherpaonnx.slid.core.LanguageIdErrorCodes
import com.sherpaonnx.slid.pipeline.SlidOfflineLivePipelineWorker
import com.sherpaonnx.text.pipeline.TextPipelineRegistry

internal class SherpaOnnxLanguageIdLivePipelineHelper(
  private val context: ReactApplicationContext,
  private val languageIdHelper: SherpaOnnxLanguageIdHelper,
  private val logTag: String,
) {

  fun startLanguageIdOfflineLivePipeline(
    instanceId: String,
    audioInLiveBufferId: String,
    textOutLiveBufferId: String,
    options: ReadableMap,
    promise: Promise,
  ) {
    try {
      if (instanceId.isBlank()) {
        promise.reject(LanguageIdErrorCodes.INVALID_ARGUMENT, "instanceId is required")
        return
      }

      val slid = languageIdHelper.getInstance(instanceId)
      if (slid == null) {
        promise.reject(
          LanguageIdErrorCodes.NOT_INITIALIZED,
          "SLID instance not found: $instanceId",
        )
        return
      }

      val audioEntry = PipelineAudioRegistry.getLive(audioInLiveBufferId)
      if (audioEntry == null) {
        promise.reject(
          LanguageIdErrorCodes.BUFFER_NOT_FOUND,
          "Input live audio buffer not found: $audioInLiveBufferId",
        )
        return
      }

      val textEntry = TextPipelineRegistry.getLive(textOutLiveBufferId)
      if (textEntry == null) {
        promise.reject(
          LanguageIdErrorCodes.BUFFER_NOT_FOUND,
          "Output live text buffer not found: $textOutLiveBufferId",
        )
        return
      }

      val attachedSegmentationEngineId =
        options.getString("attachedSegmentationEngineId")?.trim().orEmpty()
      if (attachedSegmentationEngineId.isEmpty()) {
        promise.reject(
          LanguageIdErrorCodes.INVALID_ARGUMENT,
          "attachedSegmentationEngineId is required",
        )
        return
      }

      val segmentLiveBufferId =
        options.getString("segmentLiveBufferId")?.trim().orEmpty()
      if (segmentLiveBufferId.isEmpty()) {
        promise.reject(
          LanguageIdErrorCodes.INVALID_ARGUMENT,
          "segmentLiveBufferId is required",
        )
        return
      }

      val segmentEntry = SegmentPipelineRegistry.getLive(segmentLiveBufferId)
      if (segmentEntry == null) {
        promise.reject(
          LanguageIdErrorCodes.BUFFER_NOT_FOUND,
          "Input live segment buffer not found: $segmentLiveBufferId",
        )
        return
      }

      val targetSegmentLiveBufferId =
        if (options.hasKey("targetSegmentLiveBufferId") && !options.isNull("targetSegmentLiveBufferId")) {
          options.getString("targetSegmentLiveBufferId")?.trim().orEmpty()
        } else {
          ""
        }

      val segmentsOutEntry = if (targetSegmentLiveBufferId.isNotEmpty()) {
        val entry = SegmentPipelineRegistry.getLive(targetSegmentLiveBufferId)
        if (entry == null) {
          promise.reject(
            LanguageIdErrorCodes.BUFFER_NOT_FOUND,
            "Output live segment buffer not found: $targetSegmentLiveBufferId",
          )
          return
        }
        entry
      } else {
        null
      }

      val pipelineId = "slid_live_" + java.util.UUID.randomUUID().toString()
      val worker = SlidOfflineLivePipelineWorker(
        pipelineId = pipelineId,
        attachedSegmentationEngineId = attachedSegmentationEngineId,
        audioInputRef = OfflineLivePipelineWorker.AudioInput(
          liveAudioEntry = audioEntry,
          liveSegmentEntry = segmentEntry,
        ),
        audioInBufferId = audioInLiveBufferId,
        slid = slid,
        textOutputEntry = textEntry,
        segmentsOutEntry = segmentsOutEntry,
      )

      val registeredId = StreamingPipelineRegistry.registerAndStart(worker) { completion ->
        emitPipelineCompletedEvent(completion)
      }

      val out = Arguments.createMap()
      out.putString("pipelineId", registeredId)
      promise.resolve(out)
    } catch (e: Exception) {
      Log.e(logTag, "startLanguageIdOfflineLivePipeline failed: ${e.message}", e)
      promise.reject(
        LanguageIdErrorCodes.IDENTIFY_FAILED,
        "live SLID failed: ${e.message}",
        e,
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
