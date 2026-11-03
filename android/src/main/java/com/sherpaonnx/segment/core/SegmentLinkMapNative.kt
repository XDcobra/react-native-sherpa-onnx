package com.sherpaonnx.segment.core

/** JNI facade for shared C++ SegmentLinkMapRegistry. */
internal object SegmentLinkMapNative {
  @JvmStatic external fun nativeCreate(textBufferId: String?, audioBufferId: String?): String?

  @JvmStatic
  external fun nativeAddLink(
    linkMapId: String,
    textSegmentId: String,
    speechSegmentId: String,
    linkType: String,
    hasConfidence: Boolean,
    confidence: Float,
    metaJson: String?,
  ): String?

  @JvmStatic external fun nativeRemoveLink(linkMapId: String, linkId: String): Boolean
  @JvmStatic external fun nativeGetCount(linkMapId: String): Int
  @JvmStatic external fun nativeRelease(linkMapId: String): Boolean
}