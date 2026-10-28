package com.sherpaonnx.pdf

/** JNI bridge for PDFium text-layer extract / page raster (stub when HAVE_PDFIUM is off). */
internal object PdfNative {
  init {
    System.loadLibrary("sherpaonnx")
  }

  external fun nativeIsPdfiumEnabled(): Boolean

  /**
   * Returns Object[]:
   * ok, errorCode, errorMessage, text, pageCount, pagesWithText, spans[]
   *
   * [path] filesystem path, or empty when [fd] is a borrowed ParcelFileDescriptor.
   */
  external fun nativeExtractTextLayer(
    path: String,
    fd: Int,
    pages: IntArray?,
    password: String?,
  ): Array<Any?>

  /**
   * Rasterize pages into a new OfflineImageBuffer.
   * [strategy]: `"rasterize-all"` (default) or `"lazy-lru"`.
   * [hotFrames]: only for lazy-lru (native clamps 1..32; default 8 when <= 0).
   * Returns HashMap: ok, errorCode?, errorMessage?, bufferId, frameCount, …
   */
  external fun nativeRasterizePages(
    path: String,
    fd: Int,
    pages: IntArray?,
    dpi: Int,
    maxSide: Int,
    strategy: String?,
    hotFrames: Int,
    password: String?,
  ): HashMap<String, Any>
}
