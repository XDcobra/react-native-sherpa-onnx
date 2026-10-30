package com.sherpaonnx.document

internal object DocumentNative {
  init {
    System.loadLibrary("sherpaonnx")
  }

  /**
   * [path] filesystem path, or empty when using [fd].
   * [fd] seekable descriptor (>=0) or -1.
   * Returns HashMap: ok, errorCode?, errorMessage?, format, text, sections, imageOnly, spans.
   */
  external fun nativeExtractText(
    path: String,
    fd: Int,
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
