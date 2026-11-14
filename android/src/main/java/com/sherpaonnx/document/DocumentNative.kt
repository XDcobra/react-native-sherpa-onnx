package com.sherpaonnx.document

internal object DocumentNative {
  init {
    System.loadLibrary("sherpaonnx")
  }

  /**
   * Extracts text into the native offline text buffer [bufferId] (text, markup
   * spans and, for EPUB, the reading structure).
   * [path] filesystem path, or empty when using [fd].
   * [fd] seekable descriptor (>=0) or -1.
   * Returns HashMap: ok, errorCode?, errorMessage?, format, sectionCount,
   * spatialSpanCount, sections, imageOnlySections, structure?.
   */
  external fun nativeExtractTextInto(
    path: String,
    fd: Int,
    bufferId: String,
    progress: NativeDocProgress?,
  ): HashMap<String, Any>

  /**
   * Creates an OfflineImageBuffer. Returns HashMap with ok, bufferId, format, frameCount.
   * [allImages]: also images inside text sections (EPUB), one frame per path.
   * [lazy]: comic pages stay in the archive and decode on demand (lazy-lru,
   * [hotFrames] clamped 1..32); the archive stays open until the buffer is released.
   */
  /** Container format by content; HashMap with ok, format ("" = unrecognized), errorCode?, errorMessage?. */
  external fun nativeDetectFormat(path: String, fd: Int): HashMap<String, Any>

  external fun nativeExtractImages(
    path: String,
    fd: Int,
    maxSide: Int,
    allImages: Boolean,
    lazy: Boolean,
    hotFrames: Int,
    progress: NativeDocProgress?,
  ): HashMap<String, Any>
}
