package com.sherpaonnx.slid.pipeline

import android.os.SystemClock
import android.util.Log
import com.k2fsa.sherpa.onnx.OfflineStream
import com.k2fsa.sherpa.onnx.SpokenLanguageIdentification
import com.sherpaonnx.livePipeline.CommittedSegmentRef
import com.sherpaonnx.livePipeline.OfflineLivePipelineWorker
import com.sherpaonnx.segment.pipeline.LiveSegmentEntry
import com.sherpaonnx.lifecycle.NativeInstanceGate
import com.sherpaonnx.slid.core.LanguageIdDebug
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

  private val slidIdentity = System.identityHashCode(slid)
  private val gateKey = NativeInstanceGate.keyFor(slid)

  init {
    LanguageIdDebug.lifecycle(
      "worker.created",
      "pipelineId=$pipelineId audioIn=$audioInBufferId slid=$slidIdentity " +
        "segOut=${segmentsOutEntry?.bufferId ?: "-"}",
    )
  }

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

    val entry = audioInputRef.liveAudioEntry
    val snap = entry.debugIndexSnapshot()
    val startAbs = speech.startSample.toLong()
    val endAbs = speech.endSample.toLong()
    val startBeyondWritten = startAbs >= snap.written
    val startOutsideRingWindow =
      startAbs < snap.oldestInRing || startAbs >= snap.written

    LanguageIdDebug.sample(
      "pipelineId=$pipelineId start=$startAbs end=$endAbs frameCount=$frameCount " +
        "durationMs=$durationMs sampleRate=${speech.sampleRate} " +
        "startBeyondWritten=$startBeyondWritten startOutsideRingWindow=$startOutsideRingWindow " +
        "$snap",
    )

    val samples = entry.getSamplesSlice(
      startFrame = speech.startSample,
      frameCount = frameCount,
    )

    // Diagnostic only: length if we treated startSample as absolute and mapped into the ring.
    val absMappedLen =
      if (startAbs >= snap.oldestInRing && startAbs < snap.written) {
        val rel = (startAbs - snap.oldestInRing).toInt()
        entry.getSamplesSlice(rel, frameCount).size
      } else {
        -1
      }

    LanguageIdDebug.sample(
      "pipelineId=$pipelineId ringRelativeLen=${samples.size} absMappedLen=$absMappedLen " +
        "requested=$frameCount emptyRingSlice=${samples.isEmpty()} " +
        "indexMismatch=${absMappedLen >= 0 && absMappedLen != samples.size}",
    )

    if (samples.isEmpty()) {
      LanguageIdDebug.warn(
        "empty ring slice pipelineId=$pipelineId start=$startAbs end=$endAbs " +
          "frameCount=$frameCount $snap",
      )
      return
    }

    if (!NativeInstanceGate.beginUse(gateKey)) {
      LanguageIdDebug.warn(
        "live.skipReleased pipelineId=$pipelineId slid=$slidIdentity " +
          "start=${speech.startSample} end=${speech.endSample}",
      )
      return
    }

    val opId = LanguageIdDebug.nextOpId()
    LanguageIdDebug.computeEnter(
      slidIdentity = slidIdentity,
      where = "live.onSegmentCommitted",
      opId = opId,
      detail = "pipelineId=$pipelineId samples=${samples.size} sr=${speech.sampleRate}",
    )
    var stream: OfflineStream? = null
    val lang: String
    val t0 = SystemClock.uptimeMillis()
    try {
      stream = slid.createStream()
      LanguageIdDebug.lifecycle(
        "live.streamCreated",
        "op=$opId pipelineId=$pipelineId streamNull=${stream == null}",
      )
      stream.acceptWaveform(samples, speech.sampleRate)
      LanguageIdDebug.lifecycle(
        "live.beforeCompute",
        "op=$opId pipelineId=$pipelineId samples=${samples.size}",
      )
      lang = slid.compute(stream).trim()
    } catch (t: Throwable) {
      LanguageIdDebug.warn(
        "live.computeThrowable op=$opId pipelineId=$pipelineId type=${t.javaClass.name} msg=${t.message}",
      )
      throw t
    } finally {
      try {
        stream?.release()
      } catch (_: Exception) {
      }
      LanguageIdDebug.computeLeave(
        slidIdentity = slidIdentity,
        where = "live.onSegmentCommitted",
        opId = opId,
        detail = "pipelineId=$pipelineId elapsedMs=${SystemClock.uptimeMillis() - t0}",
      )
      NativeInstanceGate.endUse(gateKey)
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
