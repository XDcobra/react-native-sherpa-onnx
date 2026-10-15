package com.sherpaonnx.image

/**
 * JNI facade for C++ ImageRegistry / ImageDecoder.
 * Loaded via [com.sherpaonnx.SherpaOnnxNativeLoader].
 */
internal object ImageBufferNative {
  @JvmStatic external fun nativeInit(cacheDir: String, totalRamBytes: Long)
  @JvmStatic external fun nativeCreateEmpty(): String
  @JvmStatic
  external fun nativeDecodeAndAppend(
    bufferId: String,
    bytes: ByteArray,
    maxSide: Int,
    fileOrigin: Boolean,
  ): HashMap<String, Any>?

  @JvmStatic
  external fun nativeAppendRgb(
    bufferId: String,
    width: Int,
    height: Int,
    rgb: ByteArray,
    fileOrigin: Boolean,
  ): HashMap<String, Any>?

  @JvmStatic external fun nativeMaybeUpgrade(bufferId: String, fileOrigin: Boolean)
  @JvmStatic external fun nativeGetInfo(bufferId: String): HashMap<String, Any>?
  @JvmStatic
  external fun nativeGetFrameInfo(bufferId: String, frameIndex: Int): HashMap<String, Any>?
  @JvmStatic external fun nativeRelease(bufferId: String): Boolean
  @JvmStatic external fun nativeDetectFormat(bytes: ByteArray): String
}
