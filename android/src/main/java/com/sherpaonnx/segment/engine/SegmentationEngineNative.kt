package com.sherpaonnx.segment.engine

import com.sherpaonnx.SherpaOnnxNativeLoader

/** JNI entry points for the shared C++ SegEngine. */
internal object SegmentationEngineNative {
  init {
    SherpaOnnxNativeLoader.ensureLoaded()
  }

  @JvmStatic external fun nativeAttach(bufferId: String, domain: String, policyJson: String): String

  @JvmStatic
  external fun nativeDetach(engineId: String, flushFinal: Boolean): String

  @JvmStatic external fun nativeGetInfo(engineId: String): String

  @JvmStatic
  external fun nativeSegmentOffline(bufferId: String, domain: String, policyJson: String): String

  @JvmStatic external fun nativeFlush(engineId: String): String

  @JvmStatic external fun nativePeekAnnotation(segmentId: String): String

  @JvmStatic
  external fun nativeRecordAnnotation(
    segmentId: String,
    reason: String,
    source: String,
    createdAtMs: Long,
    segmentIndex: Int,
  )

  @JvmStatic external fun nativeReleaseAll()
}
