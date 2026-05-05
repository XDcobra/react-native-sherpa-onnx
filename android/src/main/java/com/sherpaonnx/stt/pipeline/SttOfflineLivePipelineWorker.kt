package com.sherpaonnx.stt.pipeline

import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineStream
import com.sherpaonnx.livePipeline.CommittedSegmentRef
import com.sherpaonnx.livePipeline.OfflineLivePipelineWorker
import com.sherpaonnx.text.pipeline.LiveTextEntry

internal class SttOfflineLivePipelineWorker(
  pipelineId: String,
  attachedSegmentationEngineId: String,
  private val audioInputRef: AudioInput,
  private val recognizer: OfflineRecognizer,
  private val textOutputEntry: LiveTextEntry,
  private val chunkSize: Int = 3200,
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

    val stream: OfflineStream = recognizer.createStream()
    try {
      if (frameCount <= chunkSize) {
        // Short segment: one-shot feed.
        val samples = audioInputRef.liveAudioEntry.getSamplesSlice(
          startFrame = speech.startSample,
          frameCount = frameCount,
        )
        if (samples.isEmpty()) return
        stream.acceptWaveform(samples, speech.sampleRate)
      } else {
        // Long segment: feed in chunkSize batches before decoding.
        // Whisper uses an internal 30-second window; see docs/stt-offline.md.
        var offset = speech.startSample
        val end = speech.endSample
        while (offset < end) {
          val count = minOf(chunkSize, end - offset)
          val chunk = audioInputRef.liveAudioEntry.getSamplesSlice(
            startFrame = offset,
            frameCount = count,
          )
          if (chunk.isEmpty()) break
          stream.acceptWaveform(chunk, speech.sampleRate)
          offset += count
        }
      }
      recognizer.decode(stream)
      val result = recognizer.getResult(stream)

      textOutputEntry.commitSegment(
        text = result.text,
        tokens = result.tokens,
        timestamps = result.timestamps,
        source = "segmentation_engine",
      )
      addUnitsWritten(result.text.length.toLong())
    } finally {
      stream.release()
    }
  }
}
