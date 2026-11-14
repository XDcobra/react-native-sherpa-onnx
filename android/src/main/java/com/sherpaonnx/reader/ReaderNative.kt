package com.sherpaonnx.reader

/** JNI for the shared reader core. Each call returns [jsonOrCode, message]. */
internal object ReaderNative {
  init {
    System.loadLibrary("sherpaonnx")
  }

  @JvmStatic external fun nativeSha256OfSource(path: String, fd: Int): Array<String>

  @JvmStatic external fun nativeCreateDocument(
    textBufferId: String,
    imageBufferId: String,
    documentKey: String,
  ): Array<String>

  @JvmStatic external fun nativeInsertSection(
    documentId: String,
    after: String,
    sectionId: String,
    title: String,
    keys: Array<String>,
    types: Array<String>,
    texts: Array<String>,
    levels: IntArray,
  ): Array<String>

  @JvmStatic external fun nativeRemoveSection(documentId: String, sectionId: String): Array<String>

  @JvmStatic external fun nativeGetBlocks(
    documentId: String,
    start: Int,
    max: Int,
    includeText: Boolean,
  ): Array<String>

  @JvmStatic external fun nativeFindBlockByHash(
    documentId: String,
    textHash: String,
    hintBlockId: String,
  ): Array<String>

  @JvmStatic external fun nativeMapTextRanges(documentId: String, starts: IntArray, ends: IntArray): Array<String>

  @JvmStatic external fun nativeReleaseDocument(documentId: String): Boolean
}
