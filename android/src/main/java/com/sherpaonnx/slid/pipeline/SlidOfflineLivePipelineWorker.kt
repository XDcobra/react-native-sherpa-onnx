package com.sherpaonnx.slid.pipeline

import android.util.Log
import com.k2fsa.sherpa.onnx.OfflineStream
import com.k2fsa.sherpa.onnx.SpokenLanguageIdentification
import com.sherpaonnx.livePipeline.CommittedSegmentRef
import com.sherpaonnx.livePipeline.OfflineLivePipelineWorker
import com.sherpaonnx.segment.pipeline.LiveSegmentEntry
import com.sherpaonnx.text.pipeline.LiveTextEntry
import org.json.JSONObject

/**
 * Live-overload worker: on each speech commit, run Whisper SLID and commit the
 * ISO language code to [textOutputEntry]. Optionally also append a
 * LanguageIdSpeechSegmentPayload to [segmentsOutEntry].
 */
internal class SlidOfflineLivePipelineWorker(
  pipelineId: String,
  attachedSegmentationEngineId: String,
  private val audioInputRef: AudioInput,
  private val audioInBufferId: String,
  private val slid: SpokenLanguageIdentification,
  private val textOutputEntry: LiveTextEntry,
  private val segmentsOutEntry: LiveSegmentEntry?,
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

    val durationMs = if (speech.durationMs > 0) {
      speech.durationMs
    } else if (speech.sampleRate > 0) {
      (frameCount * 1000) / speech.sampleRate
    } else {
      0
    }

    if (durationMs < MIN_DURATION_MS) {
      Log.d(
        TAG,
        "skip short span start=${speech.startSample} end=${speech.endSample} " +
          "durationMs=$durationMs (min=$MIN_DURATION_MS)",
      )
      return
    }

    val samples = audioInputRef.liveAudioEntry.getSamplesSlice(
      startFrame = speech.startSample,
      frameCount = frameCount,
    )
    if (samples.isEmpty()) return

    var stream: OfflineStream? = null
    val lang: String
    try {
      stream = slid.createStream()
      stream.acceptWaveform(samples, speech.sampleRate)
      lang = slid.compute(stream).trim()
    } finally {
      try {
        stream?.release()
      } catch (_: Exception) {
      }
    }

    if (lang.isEmpty()) {
      Log.d(TAG, "empty lang for span start=${speech.startSample} end=${speech.endSample}")
      return
    }

    val startTime =
      if (speech.sampleRate > 0) speech.startSample.toFloat() / speech.sampleRate.toFloat() else 0f
    val endTime =
      if (speech.sampleRate > 0) speech.endSample.toFloat() / speech.sampleRate.toFloat() else 0f

    textOutputEntry.commitSegment(
      text = lang,
      tokens = emptyArray(),
      timestamps = floatArrayOf(startTime, endTime),
      source = "language_id",
      meta = mapOf("durationMs" to durationMs),
    )
    addUnitsWritten(lang.length.toLong())

    val out = segmentsOutEntry ?: return
    val sourceAudioBufferId = speech.sourceAudioBufferId.ifBlank { audioInBufferId }
    val payloadJson = JSONObject()
      .put("source", "languageId")
      .put("lang", lang)
      .toString()

    out.appendSegment(
      kind = "speech",
      sourceAudioBufferId = sourceAudioBufferId,
      startSample = speech.startSample,
      endSample = speech.endSample,
      sampleRate = speech.sampleRate,
      durationMs = durationMs,
      confidence = speech.confidence,
      payloadJson = payloadJson,
      forceEmitAppendedEvent = true,
    )
  }

  companion object {
    private const val TAG = "SherpaOnnx:slid-live"
    private const val MIN_DURATION_MS = 1500
  }
}
