package com.sherpaonnx.separation.pipeline

import android.util.Log
import com.sherpaonnx.audio.pipeline.LIVE_APPEND_SOURCE_SEPARATION
import com.sherpaonnx.audio.pipeline.LiveEntry
import com.sherpaonnx.livePipeline.CommittedSegmentRef
import com.sherpaonnx.livePipeline.OfflineLivePipelineWorker
import com.sherpaonnx.separation.core.SeparationErrorCodes

internal class SeparationOfflineLivePipelineWorker(
  pipelineId: String,
  attachedSegmentationEngineId: String,
  private val audioInputRef: AudioInput,
  private val processSeparation: (FloatArray, Int) -> Array<FloatArray>?,
  private val audioOutputEntries: List<LiveEntry>,
) : OfflineLivePipelineWorker(
  pipelineId = pipelineId,
  attachedSegmentationEngineId = attachedSegmentationEngineId,
  audioInput = audioInputRef,
  textInput = null,
) {
  override fun onSegmentCommitted(segment: CommittedSegmentRef) {
    val speech = segment as? CommittedSegmentRef.Speech
      ?: error("Expected speech segment in separation live overload")

    val frameCount = (speech.endSample - speech.startSample).coerceAtLeast(0)
    if (frameCount == 0) return

    val pcm = audioInputRef.liveAudioEntry.getSamplesSlice(
      startFrame = speech.startSample,
      frameCount = frameCount,
    )
    if (pcm.isEmpty()) return

    Log.i(
      SeparationErrorCodes.TAG,
      "liveSeparation segment: pipelineId=$pipelineId frames=$frameCount " +
        "sampleRate=${speech.sampleRate} start=${speech.startSample} end=${speech.endSample}",
    )
    val stems = processSeparation(pcm, speech.sampleRate)
      ?: error("SEPARATION_ERROR: native separation returned null")
    if (stems.size != audioOutputEntries.size) {
      error(
        "SEPARATION_ERROR: expected ${audioOutputEntries.size} stems, got ${stems.size}",
      )
    }

    var stem0SamplesWritten = 0L
    for (i in audioOutputEntries.indices) {
      val stemSamples = stems[i]
      if (stemSamples.isEmpty()) continue

      val output = audioOutputEntries[i]
      if (output.sampleRate != speech.sampleRate) {
        error(
          "SEPARATION_SAMPLE_RATE_MISMATCH: live audio out[$i] is ${output.sampleRate} Hz; chunk is ${speech.sampleRate} Hz",
        )
      }

      val result = output.tryAppendSamples(
        samples = stemSamples,
        inputSampleRate = speech.sampleRate,
        source = LIVE_APPEND_SOURCE_SEPARATION,
      )
      if (result == LiveEntry.AppendResult.BUFFER_FINALIZED) {
        stop()
        return
      }
      if (result == LiveEntry.AppendResult.APPENDED && i == 0) {
        stem0SamplesWritten = stemSamples.size.toLong()
      }
    }

    if (stem0SamplesWritten > 0) {
      addUnitsWritten(stem0SamplesWritten)
    }
  }
}
