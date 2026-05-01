package com.sherpaonnx.segment.pipeline

/**
 * Injected by [com.sherpaonnx.SherpaOnnxModule] to emit [pipelineLiveSegmentAppended] to JS.
 */
object SegmentBufferEventBridge {
  @JvmField
  var emitSegmentAppended:
    ((liveBufferId: String, record: SegmentRecord, segmentIndex: Int, totalSegments: Int) -> Unit)? =
    null
}
