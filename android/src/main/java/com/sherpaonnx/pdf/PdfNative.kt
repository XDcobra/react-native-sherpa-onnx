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
   */
  external fun nativeExtractTextLayer(
    pdfBytes: ByteArray,
    pages: IntArray?,
  ): Array<Any?>

  /**
   * Rasterize pages into a new OfflineImageBuffer.
   * Returns HashMap: ok, errorCode?, errorMessage?, bufferId, frameCount, …
   */
  external fun nativeRasterizePages(
    pdfBytes: ByteArray,
    pages: IntArray?,
    dpi: Int,
    maxSide: Int,
  ): HashMap<String, Any>
}
