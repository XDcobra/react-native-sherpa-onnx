package com.sherpaonnx.image

/**
 * JNI facade for C++ ImageRegistry / ImageDecoder.
 * Loaded via [com.sherpaonnx.SherpaOnnxNativeLoader].
 */
internal object ImageBufferNative {
  @JvmStatic external fun nativeInit(cacheDir: String, totalRamBytes: Long)
  @JvmStatic external fun nativeCreateEmpty(): String

  @JvmStatic
  external fun nativeCreateLive(ringFrames: Int, sessionRetention: Boolean): HashMap<String, Any>?

  @JvmStatic
  external fun nativeAppendLive(bufferId: String, bytes: ByteArray): HashMap<String, Any>?

  @JvmStatic
  external fun nativeFinishLive(bufferId: String): HashMap<String, Any>?

  @JvmStatic
  external fun nativeCreateFromFiles(
    paths: Array<String>,
    maxSide: Int,
    hotFrames: Int,
  ): HashMap<String, Any>?

  @JvmStatic
  external fun nativeCreateFromBytesList(
    blobs: Array<ByteArray>,
    maxSide: Int,
    hotFrames: Int,
    fileOrigin: Boolean,
  ): HashMap<String, Any>?
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

  /**
   * Ensure frame RGB is resident (lazy-lru rasterize if cold).
   * Returns map with `ok` and frame info fields, or `errorCode`/`errorMessage`.
   */
  @JvmStatic
  external fun nativeEnsureFrame(bufferId: String, frameIndex: Int): HashMap<String, Any>?

  @JvmStatic external fun nativeRelease(bufferId: String): Boolean
  @JvmStatic external fun nativeDetectFormat(bytes: ByteArray): String

  /**
   * Encode one frame to an absolute filesystem path.
   * Returns map with `ok`, and on failure `errorCode` / `errorMessage`.
   */
  @JvmStatic
  external fun nativeExportFrame(
    bufferId: String,
    frameIndex: Int,
    outPath: String,
    format: String,
    quality: Int,
    maxSide: Int,
  ): HashMap<String, Any>?

  /**
   * Build an ARGB_8888 Bitmap for FrameView (fills pixels in JNI; no RGB ByteArray hop).
   */
  @JvmStatic
  external fun nativeCreateFrameBitmap(
    bufferId: String,
    frameIndex: Int,
    maxSide: Int,
  ): android.graphics.Bitmap?
}
