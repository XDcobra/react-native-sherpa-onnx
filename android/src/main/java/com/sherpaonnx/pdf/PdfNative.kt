package com.sherpaonnx.pdf

/** JNI bridge for PDFium text-layer extract (stub when HAVE_PDFIUM is off). */
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
}
