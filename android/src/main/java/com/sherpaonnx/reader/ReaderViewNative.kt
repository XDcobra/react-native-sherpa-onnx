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

  /** 4 ints per row: block, coverFirst, coverLast, page (see reader/ReaderLayout.h). */
  @JvmStatic external fun nativePlanRows(handle: Long, pageDisplay: String): IntArray

  /**
   * [first, last] visible blocks of a row, or an empty array. [shown]: any part in the
   * window counts (visible range); else at least half (reading progress).
   */
  @JvmStatic external fun nativeRowVisibleBlocks(
    handle: Long,
    block: Int,
    coverFirst: Int,
    coverLast: Int,
    page: Boolean,
    visibleTop: Float,
    visibleBottom: Float,
    rowHeight: Float,
    viewport: Float,
    shown: Boolean,
  ): IntArray

  /** 4 floats per rect (x, y, w, h normalized to the page) of [start, end) of a block's text. */
  @JvmStatic external fun nativeTextRangeRects(handle: Long, block: Int, start: Int, end: Int): FloatArray

  /** Px from a row's top where [target] starts (a block's place on a page image; else 0). */
  @JvmStatic external fun nativeBlockOffsetInRow(
    handle: Long,
    block: Int,
    page: Boolean,
    target: Int,
    rowHeight: Float,
  ): Float

  @JvmStatic external fun nativeBlockId(handle: Long, index: Int): String?

  @JvmStatic external fun nativeSectionId(handle: Long, index: Int): String?

  @JvmStatic external fun nativeBlockText(handle: Long, index: Int): String?

  /** Inline styles: (start, end, flags) per run, UTF-16 in the block text; flags 1 italic, 2 bold. */
  @JvmStatic external fun nativeBlockStyles(handle: Long, index: Int): IntArray

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

  /**
   * Margin markers: [invalidCount, invalid input indices…, then per resolved marker:
   * block, input index, offset (-1 = the block's first line)].
   */
  @JvmStatic external fun nativeResolveMarkers(
    handle: Long,
    ids: Array<String>,
    blockIds: Array<String>,
    starts: IntArray,
    ends: IntArray,
  ): IntArray

  /** Marker line on a page image: x, y, w, h normalized to the page. */
  @JvmStatic external fun nativeMarkerPageRect(handle: Long, block: Int, offset: Int): FloatArray

  /** [start, end) widened by [mode] (SNAP_*): to sentences or the whole block. */
  @JvmStatic external fun nativeSnapRange(handle: Long, block: Int, start: Int, end: Int, mode: Int): IntArray

  /** [first, last]: read range (progress, jumps); [shownFirst, shownLast]: the visible range. */
  @JvmStatic external fun nativeTrackerSample(
    handle: Long,
    first: Int,
    last: Int,
    phase: Int,
    shownFirst: Int,
    shownLast: Int,
  ): IntArray

  const val PHASE_DRAG = 0
  const val PHASE_MOMENTUM = 1
  const val PHASE_IDLE = 2
  const val PHASE_PROGRAMMATIC = 3
  const val PHASE_LAYOUT = 4
  const val PHASE_FOLLOW = 5

  const val SNAP_NONE = 0
  const val SNAP_SENTENCE = 1
  const val SNAP_BLOCK = 2
}
