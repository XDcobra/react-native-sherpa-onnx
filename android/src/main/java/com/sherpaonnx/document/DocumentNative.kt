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
   */
  external fun nativeExtractImages(
    path: String,
    fd: Int,
    maxSide: Int,
    progress: NativeDocProgress?,
  ): HashMap<String, Any>
}
