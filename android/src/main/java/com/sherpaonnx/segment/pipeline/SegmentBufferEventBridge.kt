package com.sherpaonnx.segment.pipeline

/**
 * Injected by [com.sherpaonnx.SherpaOnnxModule] to emit [pipelineLiveSegmentAppended] to JS.
 */
object SegmentBufferEventBridge {
  @JvmField
  var emitSegmentAppended:
    ((segmentBufferId: String, record: SegmentRecord, segmentIndex: Int, totalSegments: Int) -> Unit)? =
    null

  /** Called from the shared SegEngine after a speech segment is committed. */
  @JvmStatic
  fun emitFromNative(
    bufferId: String,
    segmentId: String,
    kind: String,
    segmentIndex: Int,
    totalSegments: Int,
    sourceAudioBufferId: String,
    startSample: Int,
    endSample: Int,
    sampleRate: Int,
    durationMs: Int,
    hasConfidence: Boolean,
    confidence: Double,
    payloadJson: String,
  ) {
    val rec =
      SegmentRecord(
        id = segmentId,
        kind = kind,
        sourceAudioBufferId = sourceAudioBufferId,
        startSample = startSample,
        endSample = endSample,
        sampleRate = sampleRate,
        durationMs = durationMs,
        confidence = if (hasConfidence) confidence else null,
        payloadJson = payloadJson,
      )
    emitSegmentAppended?.invoke(bufferId, rec, segmentIndex, totalSegments)
  }
}
