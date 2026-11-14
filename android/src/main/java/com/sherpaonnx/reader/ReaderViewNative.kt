package com.sherpaonnx.reader

/** JNI for [SherpaReaderView]: snapshot reads and the shared reading tracker. */
internal object ReaderViewNative {
  init {
    System.loadLibrary("sherpaonnx")
  }

  @JvmStatic external fun nativeSnapshotRetain(documentId: String): Long

  @JvmStatic external fun nativePlaceholderSnapshot(rows: Int): Long

  @JvmStatic external fun nativeSnapshotRelease(handle: Long)

  @JvmStatic external fun nativeBlockTable(handle: Long): IntArray

  @JvmStatic external fun nativeSectionTable(handle: Long): IntArray

  @JvmStatic external fun nativeBlockId(handle: Long, index: Int): String?

  @JvmStatic external fun nativeSectionId(handle: Long, index: Int): String?

  @JvmStatic external fun nativeBlockText(handle: Long, index: Int): String?

  @JvmStatic external fun nativeBlockAlt(handle: Long, index: Int): String?

  @JvmStatic external fun nativeImageBufferId(handle: Long): String

  @JvmStatic external fun nativeLanguage(handle: Long): String

  @JvmStatic external fun nativeBlockIndex(handle: Long, blockId: String): Int

  @JvmStatic external fun nativeSectionIndex(handle: Long, sectionId: String): Int

  @JvmStatic external fun nativeTrackerCreate(sectionLastBlocks: IntArray, jumpThreshold: Int): Long

  @JvmStatic external fun nativeTrackerDestroy(handle: Long)

  @JvmStatic external fun nativeTrackerSetFrontier(handle: Long, block: Int)

  @JvmStatic external fun nativeTrackerSetThreshold(handle: Long, blocks: Int)

  @JvmStatic external fun nativeTrackerFrontier(handle: Long): Int

  /** See sherpa-onnx-reader-view-jni.cpp for the packed result layout. */
  @JvmStatic external fun nativeResolveHighlights(
    handle: Long,
    ids: Array<String>,
    fromIds: Array<String>,
    fromOffsets: IntArray,
    toIds: Array<String>,
    toOffsets: IntArray,
    styles: IntArray,
    colors: IntArray,
    flags: IntArray,
  ): IntArray

  @JvmStatic external fun nativeTrackerSample(handle: Long, first: Int, last: Int, phase: Int): IntArray

  const val PHASE_DRAG = 0
  const val PHASE_MOMENTUM = 1
  const val PHASE_IDLE = 2
  const val PHASE_PROGRAMMATIC = 3
  const val PHASE_LAYOUT = 4
  const val PHASE_FOLLOW = 5
}
