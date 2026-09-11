package com.sherpaonnx.audiotagging.pipeline

import android.os.SystemClock
import android.util.Log
import com.k2fsa.sherpa.onnx.AudioEvent
import com.k2fsa.sherpa.onnx.AudioTagging
import com.k2fsa.sherpa.onnx.OfflineStream
import com.sherpaonnx.audiotagging.core.AudioTaggingErrorCodes
import com.sherpaonnx.lifecycle.NativeInstanceGate
import com.sherpaonnx.livePipeline.CommittedSegmentRef
import com.sherpaonnx.livePipeline.OfflineLivePipelineWorker
import com.sherpaonnx.segment.pipeline.LiveSegmentEntry
import com.sherpaonnx.text.pipeline.LiveTextEntry
import org.json.JSONArray
import org.json.JSONObject

/**
 * Live-overload worker: on each speech commit, run offline AudioTagging compute and
 * commit the primary event name (+ top-K meta) to [textOutputEntry]. Optionally also
 * append an AudioTaggingSpeechSegmentPayload to [segmentsOutEntry].
 */
internal class AudioTaggingOfflineLivePipelineWorker(
  pipelineId: String,
  attachedSegmentationEngineId: String,
  private val audioInputRef: AudioInput,
  private val audioInBufferId: String,
  private val tagger: AudioTagging,
  private val topK: Int,
  private val textOutputEntry: LiveTextEntry,
  private val segmentsOutEntry: LiveSegmentEntry?,
) : OfflineLivePipelineWorker(
  pipelineId = pipelineId,
  attachedSegmentationEngineId = attachedSegmentationEngineId,
  audioInput = audioInputRef,
  textInput = null,
) {

  private val taggerIdentity = System.identityHashCode(tagger)
  private val gateKey = NativeInstanceGate.keyFor(tagger)

  init {
    Log.d(
      TAG,
      "worker.created pipelineId=$pipelineId audioIn=$audioInBufferId " +
        "tagger=$taggerIdentity topK=$topK segOut=${segmentsOutEntry?.bufferId ?: "-"}",
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
    val samples = entry.getSamplesSlice(
      startFrame = speech.startSample,
      frameCount = frameCount,
    )
    if (samples.isEmpty()) {
      Log.w(
        TAG,
        "empty ring slice pipelineId=$pipelineId start=${speech.startSample} " +
          "end=${speech.endSample} frameCount=$frameCount",
      )
      return
    }

    if (!NativeInstanceGate.beginUse(gateKey)) {
      Log.w(
        TAG,
        "live.skipReleased pipelineId=$pipelineId tagger=$taggerIdentity " +
          "start=${speech.startSample} end=${speech.endSample}",
      )
      return
    }

    var stream: OfflineStream? = null
    val events: Array<AudioEvent>
    val t0 = SystemClock.uptimeMillis()
    try {
      stream = tagger.createStream()
      stream.acceptWaveform(samples, speech.sampleRate)
      events = tagger.compute(stream, topK)
    } catch (t: Throwable) {
      Log.w(
        TAG,
        "live.computeThrowable pipelineId=$pipelineId type=${t.javaClass.name} msg=${t.message}",
      )
      throw t
    } finally {
      try {
        stream?.release()
      } catch (_: Exception) {
      }
      Log.d(
        TAG,
        "live.computeLeave pipelineId=$pipelineId elapsedMs=${SystemClock.uptimeMillis() - t0}",
      )
      NativeInstanceGate.endUse(gateKey)
    }

    if (events.isEmpty()) {
      Log.d(TAG, "empty events for span start=${speech.startSample} end=${speech.endSample}")
      return
    }

    val primary = events[0]
    val primaryName = primary.name.trim()
    if (primaryName.isEmpty()) {
      Log.d(TAG, "empty primary name for span start=${speech.startSample} end=${speech.endSample}")
      return
    }

    val startTime =
      if (speech.sampleRate > 0) speech.startSample.toFloat() / speech.sampleRate.toFloat() else 0f
    val endTime =
      if (speech.sampleRate > 0) speech.endSample.toFloat() / speech.sampleRate.toFloat() else 0f

    val eventMaps = ArrayList<Map<String, Any>>(events.size)
    val eventsJson = JSONArray()
    for (ev in events) {
      eventMaps.add(
        mapOf(
          "name" to ev.name,
          "index" to ev.index,
          "prob" to ev.prob.toDouble(),
        ),
      )
      eventsJson.put(
        JSONObject()
          .put("name", ev.name)
          .put("index", ev.index)
          .put("prob", ev.prob.toDouble()),
      )
    }

    // LiveText meta is a Fabric-safe JSON tree (nested events array).
    textOutputEntry.commitSegment(
      text = primaryName,
      tokens = emptyArray(),
      timestamps = floatArrayOf(startTime, endTime),
      source = "audio_tagging",
      meta = mapOf(
        "durationMs" to durationMs,
        "events" to eventMaps,
      ),
    )
    addUnitsWritten(primaryName.length.toLong())

    Log.d(
      TAG,
      "commit pipelineId=$pipelineId primary=$primaryName eventCount=${events.size} " +
        "durationMs=$durationMs",
    )

    val out = segmentsOutEntry ?: return
    val sourceAudioBufferId = speech.sourceAudioBufferId.ifBlank { audioInBufferId }
    val payloadJson = JSONObject()
      .put("source", "audioTagging")
      .put("primaryName", primaryName)
      .put("events", eventsJson)
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
    private const val TAG = AudioTaggingErrorCodes.TAG
    private const val MIN_DURATION_MS = 1500
  }
}
