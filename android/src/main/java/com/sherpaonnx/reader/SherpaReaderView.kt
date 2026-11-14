package com.sherpaonnx.reader

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.Configuration
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Build
import android.os.SystemClock
import android.text.Layout
import android.util.LruCache
import android.util.TypedValue
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.LinearSmoothScroller
import androidx.recyclerview.widget.RecyclerView
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.common.assets.ReactFontManager
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.events.NativeGestureUtil
import com.sherpaonnx.image.OfflineImageBufferFrameView
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

/**
 * Fabric ReaderView (Android): a RecyclerView over a native ReaderDocument
 * snapshot. React children are insert hosts ([SherpaReaderInsertView]); they
 * are kept in a logical child list (see [SherpaReaderViewManager]) and moved
 * into the rows that `inserts` assigns. Reading events come from the shared
 * C++ ReaderTracker, with the same rules as on iOS.
 */
@SuppressLint("ViewConstructor")
class SherpaReaderView(private val reactContext: ThemedReactContext) : FrameLayout(reactContext) {
  internal data class InsertSpec(val key: String, val kind: String, val target: String)

  private sealed class Row {
    /** `index` is the flat block index in the current snapshot. */
    data class Block(val id: String, val index: Int) : Row()

    data class Insert(val key: String) : Row()
  }

  /** Theme resolved to pixels. */
  private data class Theme(
    val fontSizePx: Float,
    val typeface: Typeface,
    val lineHeight: Float,
    val paragraphSpacingPx: Int,
    val marginHorizontalPx: Int,
    val marginVerticalPx: Int,
    val justify: Boolean,
    val hyphenation: Boolean,
    val textColor: Int,
  )

  /** A scroll to a block that finishes after the next layout pass(es). */
  private class PendingScroll(val row: Int, val offset: Int, val sampleAfter: Boolean) {
    var lineCorrected = false
  }

  // ---- Props ----
  private var documentId = ""
  private var documentRevision = 0
  private var debugRowCount = 0
  private var inserts: List<InsertSpec> = emptyList()
  private var initialBlockId = ""
  private var initialOffset = -1
  private var furthestBlockId = ""
  private var furthestRevision = 0
  private var jumpThreshold = 20
  private var fontFamily = ""
  private var fontSize = 18f
  private var fontScale = -1f
  private var maxFontScale = 0f
  private var lineHeight = 1.5f
  private var paragraphSpacing = 0.75f
  private var marginHorizontal = 20f
  private var marginVertical = 24f
  private var justify = false
  private var hyphenation = true
  private var textColor: Int? = null

  /** Logical React children, in Fabric's order. Not attached to this view. */
  internal val hosts = mutableListOf<SherpaReaderInsertView>()

  private val recycler = ReaderRecyclerView(reactContext)
  private val layoutManager = LinearLayoutManager(reactContext)
  private val adapter = Adapter()
  private var rows: List<Row> = emptyList()
  private val defaultTextColor = TextView(reactContext).currentTextColor
  private var theme = resolveTheme()
  private var boundTheme: Theme? = null

  // ---- Snapshot and tracker (native handles) ----
  private var snapshot = 0L
  private var tracker = 0L
  private var blockTable = IntArray(0)
  private var sectionTable = IntArray(0)
  private var imageBufferId = ""
  private var locale: Locale? = null
  private val textCache = LruCache<Int, String>(256)

  private var rebuildPosted = false
  private var initialApplied = false
  private var readySent = false
  private var programmaticScroll = false
  private var pendingScroll: PendingScroll? = null
  private var pendingLayoutSample = false
  private var lastOriginSync = 0L

  init {
    recycler.layoutManager = layoutManager
    recycler.adapter = adapter
    recycler.itemAnimator = null
    recycler.clipToPadding = false
    recycler.onLayoutDone = { if (pendingScroll != null || pendingLayoutSample) post(afterLayout) }
    addView(recycler, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    recycler.addOnScrollListener(
      object : RecyclerView.OnScrollListener() {
        override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) {
          when (rv.scrollState) {
            RecyclerView.SCROLL_STATE_DRAGGING -> sample(ReaderViewNative.PHASE_DRAG)
            RecyclerView.SCROLL_STATE_SETTLING ->
              if (!programmaticScroll) sample(ReaderViewNative.PHASE_MOMENTUM)
          }
          // Throttled: Pressability measures on touch-down; at rest the sync is exact.
          if (SystemClock.uptimeMillis() - lastOriginSync > 50) syncInsertOrigins()
        }

        override fun onScrollStateChanged(rv: RecyclerView, newState: Int) {
          when (newState) {
            RecyclerView.SCROLL_STATE_DRAGGING -> programmaticScroll = false
            RecyclerView.SCROLL_STATE_SETTLING ->
              if (!programmaticScroll) sample(ReaderViewNative.PHASE_MOMENTUM)
            RecyclerView.SCROLL_STATE_IDLE -> {
              syncInsertOrigins()
              if (programmaticScroll) {
                programmaticScroll = false
                sample(ReaderViewNative.PHASE_PROGRAMMATIC)
              }
              sample(ReaderViewNative.PHASE_IDLE)
            }
          }
        }
      }
    )
    recycler.addOnChildAttachStateChangeListener(
      object : RecyclerView.OnChildAttachStateChangeListener {
        override fun onChildViewAttachedToWindow(view: View) {
          if (view is InsertContainer) post(syncOrigins)
        }

        override fun onChildViewDetachedFromWindow(view: View) = Unit
      }
    )
    val detector =
      GestureDetector(
        reactContext,
        object : GestureDetector.SimpleOnGestureListener() {
          override fun onSingleTapUp(e: MotionEvent): Boolean {
            handleTap(e)
            return false
          }
        }
      )
    recycler.addOnItemTouchListener(
      object : RecyclerView.SimpleOnItemTouchListener() {
        override fun onInterceptTouchEvent(rv: RecyclerView, e: MotionEvent): Boolean {
          detector.onTouchEvent(e)
          return false
        }
      }
    )
  }

  // ---- Props (set by the manager) ----

  internal fun setDocumentId(value: String?) {
    val id = value ?: ""
    if (id == documentId) return
    documentId = id
    initialApplied = false
    readySent = false
    scheduleRebuild()
  }

  internal fun setDocumentRevision(value: Int) {
    if (value == documentRevision) return
    documentRevision = value
    scheduleRebuild()
  }

  internal fun setDebugRowCount(value: Int) {
    if (value == debugRowCount) return
    debugRowCount = value
    scheduleRebuild()
  }

  internal fun setInserts(value: ReadableArray?) {
    val next = mutableListOf<InsertSpec>()
    if (value != null) {
      for (i in 0 until value.size()) {
        val m = value.getMap(i) ?: continue
        next += InsertSpec(m.getString("key") ?: "", m.getString("kind") ?: "", m.getString("target") ?: "")
      }
    }
    if (next != inserts) {
      inserts = next
      scheduleRebuild()
    }
  }

  // Read once, when the first rows of a document are built.
  internal fun setInitialBlockId(value: String?) {
    initialBlockId = value ?: ""
  }

  internal fun setInitialOffset(value: Int) {
    initialOffset = value
  }

  internal fun setFurthestBlockId(value: String?) {
    furthestBlockId = value ?: ""
  }

  /** Applied after all props of a transaction (see the manager's onAfterUpdateTransaction). */
  internal fun setFurthestRevision(value: Int) {
    if (value == furthestRevision) return
    furthestRevision = value
    frontierDirty = true
  }

  private var frontierDirty = false

  internal fun setJumpThreshold(value: Int) {
    if (value == jumpThreshold) return
    jumpThreshold = value
    if (tracker != 0L) ReaderViewNative.nativeTrackerSetThreshold(tracker, value)
  }

  internal fun setFontFamily(v: String?) {
    fontFamily = v ?: ""
  }

  internal fun setFontSize(v: Float) {
    fontSize = v
  }

  internal fun setFontScale(v: Float) {
    fontScale = v
  }

  internal fun setMaxFontScale(v: Float) {
    maxFontScale = v
  }

  internal fun setLineHeight(v: Float) {
    lineHeight = v
  }

  internal fun setParagraphSpacing(v: Float) {
    paragraphSpacing = v
  }

  internal fun setMarginHorizontal(v: Float) {
    marginHorizontal = v
  }

  internal fun setMarginVertical(v: Float) {
    marginVertical = v
  }

  internal fun setTextAlign(v: String?) {
    justify = v == "justify"
  }

  internal fun setHyphenation(v: Boolean) {
    hyphenation = v
  }

  internal fun setTextColor(v: Int?) {
    textColor = v
  }

  /** Called once per Fabric props transaction. */
  internal fun onPropsApplied() {
    if (frontierDirty) {
      frontierDirty = false
      if (tracker != 0L && snapshot != 0L) {
        val idx = if (furthestBlockId.isEmpty()) -1 else ReaderViewNative.nativeBlockIndex(snapshot, furthestBlockId)
        ReaderViewNative.nativeTrackerSetFrontier(tracker, idx)
      }
    }
    val next = resolveTheme()
    if (next != theme) {
      if (pendingAnchor == null) pendingAnchor = readingAnchor()
      theme = next
      scheduleRebuild()
    }
  }

  override fun onConfigurationChanged(newConfig: Configuration?) {
    super.onConfigurationChanged(newConfig)
    // System font scale (when fontScale = -1).
    onPropsApplied()
  }

  private fun resolveTheme(): Theme {
    val metrics = resources.displayMetrics
    val base = if (fontSize > 0) fontSize else 18f
    val sizePx =
      if (fontScale < 0) {
        // Follow the system font scale (SP), optionally capped.
        val sp = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, base, metrics)
        if (maxFontScale > 0) min(sp, PixelUtil.toPixelFromDIP(base * maxFontScale)) else sp
      } else {
        PixelUtil.toPixelFromDIP(base * (if (fontScale > 0) fontScale else 1f))
      }
    val typeface =
      if (fontFamily.isNotEmpty()) {
        ReactFontManager.getInstance().getTypeface(fontFamily, Typeface.NORMAL, reactContext.assets)
      } else {
        Typeface.SERIF
      }
    return Theme(
      fontSizePx = sizePx,
      typeface = typeface,
      lineHeight = if (lineHeight > 0) lineHeight else 1.5f,
      paragraphSpacingPx = ((if (paragraphSpacing >= 0) paragraphSpacing else 0.75f) * sizePx).toInt(),
      marginHorizontalPx = PixelUtil.toPixelFromDIP(marginHorizontal).toInt(),
      marginVerticalPx = PixelUtil.toPixelFromDIP(marginVertical).toInt(),
      justify = justify,
      hyphenation = hyphenation,
      textColor = textColor ?: defaultTextColor,
    )
  }

  // ---- Children (insert hosts) ----

  internal fun addHost(host: SherpaReaderInsertView, index: Int) {
    hosts.add(index.coerceIn(0, hosts.size), host)
    host.reader = this
    scheduleRebuild()
  }

  internal fun removeHostAt(index: Int) {
    if (index !in hosts.indices) return
    val host = hosts.removeAt(index)
    host.reader = null
    (host.parent as? ViewGroup)?.removeView(host)
    scheduleRebuild()
  }

  internal fun onInsertKeyChanged(host: SherpaReaderInsertView) = scheduleRebuild()

  internal fun onInsertResized(host: SherpaReaderInsertView) {
    val key = host.insertKey
    // The LinearLayoutManager keeps the first visible row in place on a change.
    post {
      val pos = rows.indexOfFirst { it is Row.Insert && it.key == key }
      if (isAttachedToWindow && pos >= 0) adapter.notifyItemChanged(pos)
    }
  }

  private fun hostFor(key: String): SherpaReaderInsertView? = hosts.firstOrNull { it.insertKey == key }

  /** Pushes every attached insert host's position (reader coordinates) into its shadow state. */
  private fun syncInsertOrigins() {
    lastOriginSync = SystemClock.uptimeMillis()
    val loc = IntArray(2)
    val own = IntArray(2)
    getLocationInWindow(own)
    for (host in hosts) {
      if (host.parent !is InsertContainer || !host.isAttachedToWindow) continue
      host.getLocationInWindow(loc)
      host.setOnScreenOrigin(loc[0] - own[0], loc[1] - own[1])
    }
  }

  private val syncOrigins = Runnable { if (isAttachedToWindow) syncInsertOrigins() }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val oldWidth = recycler.width
    val widthChanged = oldWidth > 0 && right - left != oldWidth && rows.isNotEmpty()
    // Rows still have the old layout here: remember the text at the reading top.
    val anchor = if (widthChanged) readingAnchor() else null
    super.onLayout(changed, left, top, right, bottom)
    if (widthChanged) {
      // Width change (rotation): text reflows and image rows get new heights;
      // bring the same character back to the reading top afterwards.
      post {
        if (isAttachedToWindow) {
          adapter.notifyItemRangeChanged(0, rows.size)
          anchor?.let { restoreAnchor(it) }
          pendingLayoutSample = true
          recycler.requestLayout()
        }
      }
    }
    post(syncOrigins)
  }

  /** A position the reader keeps across reflows: block ID + UTF-16 offset. */
  private class Anchor(val blockId: String, val offset: Int)

  private var pendingAnchor: Anchor? = null

  /**
   * The character at the reading top (just below the vertical margin), or
   * null at the very start of the document (nothing to keep).
   */
  private fun readingAnchor(): Anchor? {
    if (snapshot == 0L || rows.isEmpty() || !recycler.canScrollVertically(-1)) return null
    val y = recycler.paddingTop
    // First block below the reading top, when an insert sits there.
    var fallback: Row.Block? = null
    var fallbackTop = Int.MAX_VALUE
    for (c in 0 until recycler.childCount) {
      val child = recycler.getChildAt(c)
      val row = rows.getOrNull(recycler.getChildAdapterPosition(child)) as? Row.Block ?: continue
      if (child.bottom <= y) continue
      if (child.top > y) {
        if (child.top < fallbackTop) {
          fallback = row
          fallbackTop = child.top
        }
        continue
      }
      val tv = (recycler.getChildViewHolder(child) as? TextHolder)?.text
      val layout = tv?.layout
      val offset =
        if (tv != null && layout != null) {
          val ly = y - child.top - tv.paddingTop
          if (ly > 0) layout.getLineStart(layout.getLineForVertical(ly)) else 0
        } else {
          0
        }
      return Anchor(row.id, offset)
    }
    return fallback?.let { Anchor(it.id, 0) }
  }

  private fun restoreAnchor(anchor: Anchor) {
    val block = ReaderViewNative.nativeBlockIndex(snapshot, anchor.blockId)
    if (block >= 0) scrollToBlock(block, anchor.offset, sampleAfter = false)
  }

  // ---- Snapshot and rows ----

  private fun scheduleRebuild() {
    // Fabric applies props, child mounts and layout in one batch; rebuild once after it.
    if (rebuildPosted) return
    rebuildPosted = true
    post {
      rebuildPosted = false
      rebuildRows()
    }
  }

  private fun loadSnapshot() {
    val next =
      when {
        documentId.isNotEmpty() -> ReaderViewNative.nativeSnapshotRetain(documentId)
        debugRowCount > 0 -> ReaderViewNative.nativePlaceholderSnapshot(debugRowCount)
        else -> 0L
      }
    if (documentId.isNotEmpty() && next == 0L) {
      dispatchError("ERR_READER_NOT_FOUND", "Reader document not found: $documentId")
    }
    // Flat indices shift with app sections: carry the frontier over by block ID.
    var frontierId: String? = null
    if (tracker != 0L && snapshot != 0L) {
      val f = ReaderViewNative.nativeTrackerFrontier(tracker)
      if (f >= 0) frontierId = ReaderViewNative.nativeBlockId(snapshot, f)
    }
    releaseSnapshot()
    textCache.evictAll()
    snapshot = next
    if (snapshot == 0L) {
      blockTable = IntArray(0)
      sectionTable = IntArray(0)
      imageBufferId = ""
      locale = null
      return
    }
    blockTable = ReaderViewNative.nativeBlockTable(snapshot)
    sectionTable = ReaderViewNative.nativeSectionTable(snapshot)
    imageBufferId = ReaderViewNative.nativeImageBufferId(snapshot)
    locale = ReaderViewNative.nativeLanguage(snapshot).takeIf { it.isNotEmpty() }?.let { Locale.forLanguageTag(it) }
    val sectionLast = ArrayList<Int>()
    for (s in 0 until sectionCount) {
      if (sectionBlockCount(s) > 0) sectionLast += sectionFirstBlock(s) + sectionBlockCount(s) - 1
    }
    tracker = ReaderViewNative.nativeTrackerCreate(sectionLast.toIntArray(), jumpThreshold)
    val frontier = furthestBlockId.ifEmpty { frontierId ?: "" }
    if (frontier.isNotEmpty()) {
      ReaderViewNative.nativeTrackerSetFrontier(tracker, ReaderViewNative.nativeBlockIndex(snapshot, frontier))
    }
  }

  private fun releaseSnapshot() {
    if (snapshot != 0L) ReaderViewNative.nativeSnapshotRelease(snapshot)
    if (tracker != 0L) ReaderViewNative.nativeTrackerDestroy(tracker)
    snapshot = 0L
    tracker = 0L
  }

  private val blockCount: Int get() = blockTable.size / 6
  private val sectionCount: Int get() = sectionTable.size / 2

  private fun blockType(i: Int) = blockTable[i * 6]

  private fun blockLevel(i: Int) = blockTable[i * 6 + 1]

  private fun blockSection(i: Int) = blockTable[i * 6 + 2]

  private fun blockFrame(i: Int) = blockTable[i * 6 + 3]

  private fun sectionFirstBlock(s: Int) = sectionTable[s * 2]

  private fun sectionBlockCount(s: Int) = sectionTable[s * 2 + 1]

  private fun appendInserts(kind: String, target: String, out: MutableList<Row>) {
    for (spec in inserts) {
      if (spec.kind == kind && spec.target == target && hostFor(spec.key) != null) out += Row.Insert(spec.key)
    }
  }

  private fun rebuildRows() {
    loadSnapshot()
    recycler.setPadding(0, theme.marginVerticalPx, 0, theme.marginVerticalPx)
    val next = ArrayList<Row>(blockCount + inserts.size)
    if (snapshot != 0L) {
      for (s in 0 until sectionCount) {
        for (i in sectionFirstBlock(s) until sectionFirstBlock(s) + sectionBlockCount(s)) {
          val id = ReaderViewNative.nativeBlockId(snapshot, i) ?: continue
          appendInserts("beforeBlock", id, next)
          next += Row.Block(id, i)
          appendInserts("afterBlock", id, next)
        }
        ReaderViewNative.nativeSectionId(snapshot, s)?.let { appendInserts("sectionEnd", it, next) }
      }
    }
    val old = rows
    val themeChanged = boundTheme != theme
    rows = next
    boundTheme = theme
    // Targeted updates (not notifyDataSetChanged): holders stay valid, the
    // LinearLayoutManager keeps the first visible row in place, and an unmount
    // in the middle of a screen transition does not invalidate every holder
    // before a forced layout. Rows match by block ID / insert key; a block
    // whose flat index moved (app section inserted before it) or a theme
    // change rebinds.
    DiffUtil.calculateDiff(
      object : DiffUtil.Callback() {
        override fun getOldListSize() = old.size

        override fun getNewListSize() = next.size

        override fun areItemsTheSame(o: Int, n: Int) = sameItem(old[o], next[n])

        override fun areContentsTheSame(o: Int, n: Int) = !themeChanged && old[o] == next[n]
      },
      false,
    ).dispatchUpdatesTo(adapter)

    if (snapshot == 0L || blockCount == 0) return
    val anchor = pendingAnchor
    pendingAnchor = null
    if (!initialApplied) {
      initialApplied = true
      val block = if (initialBlockId.isEmpty()) -1 else ReaderViewNative.nativeBlockIndex(snapshot, initialBlockId)
      if (block >= 0) scrollToBlock(block, initialOffset, sampleAfter = false)
    } else if (anchor != null) {
      // Theme change: the same character returns to the reading top.
      restoreAnchor(anchor)
    }
    pendingLayoutSample = true
    recycler.requestLayout()
    if (!readySent) {
      readySent = true
      ReaderEvents.dispatch(this, ReaderEvents.READY) {
        putInt("blockCount", blockCount)
        putInt("sectionCount", sectionCount)
      }
    }
  }

  private fun sameItem(a: Row, b: Row): Boolean =
    when {
      a is Row.Block && b is Row.Block -> a.id == b.id
      a is Row.Insert && b is Row.Insert -> a.key == b.key
      else -> false
    }

  private fun rowOfBlock(block: Int): Int = rows.indexOfFirst { it is Row.Block && it.index == block }

  private fun blockText(i: Int): String =
    textCache.get(i) ?: (ReaderViewNative.nativeBlockText(snapshot, i) ?: "").also { textCache.put(i, it) }

  /** Runs after a RecyclerView layout pass: finishes pending scrolls, then samples. */
  private val afterLayout =
    Runnable {
      if (!isAttachedToWindow) return@Runnable
      val p = pendingScroll
      if (p != null) {
        if (p.offset > 0 && !p.lineCorrected) {
          p.lineCorrected = true
          val holder = recycler.findViewHolderForAdapterPosition(p.row) as? TextHolder
          val layout = holder?.text?.layout
          if (holder != null && layout != null) {
            val line = layout.getLineForOffset(min(p.offset, holder.text.text.length))
            layoutManager.scrollToPositionWithOffset(p.row, -(holder.text.paddingTop + layout.getLineTop(line)))
            return@Runnable // finishes after the next layout
          }
        }
        pendingScroll = null
        syncInsertOrigins()
        if (p.sampleAfter) {
          sample(ReaderViewNative.PHASE_PROGRAMMATIC)
          sample(ReaderViewNative.PHASE_IDLE)
        }
      }
      if (pendingLayoutSample) {
        pendingLayoutSample = false
        sample(ReaderViewNative.PHASE_LAYOUT)
      }
    }

  // ---- Visibility and events ----

  /**
   * First / last visible block (flat indices). A block counts when at least
   * half of min(its height, the viewport) is on screen.
   */
  private fun visibleBlocks(insertKeys: MutableList<String>): IntArray? {
    val viewport = recycler.height
    if (viewport <= 0) return null
    var first = -1
    var last = -1
    for (c in 0 until recycler.childCount) {
      val child = recycler.getChildAt(c)
      val row = rows.getOrNull(recycler.getChildAdapterPosition(child)) ?: continue
      val shown = min(child.bottom, viewport) - max(child.top, 0)
      if (row is Row.Insert) {
        if (shown > 0) insertKeys += row.key
        continue
      }
      if (child.height <= 0 || shown < 0.5f * min(child.height, viewport)) continue
      val idx = (row as Row.Block).index
      if (first < 0 || idx < first) first = idx
      if (idx > last) last = idx
    }
    return if (first >= 0) intArrayOf(first, last) else null
  }

  /** UTF-16 offset of the first visible character in the first visible block. */
  private fun firstVisibleOffset(block: Int): Int {
    val holder = recycler.findViewHolderForAdapterPosition(rowOfBlock(block)) as? TextHolder ?: return 0
    val tv = holder.text
    val layout = tv.layout ?: return 0
    // Measured from the reading top (below the vertical margin), where
    // scrollToLocator puts the line, so save / restore round-trips.
    val y = recycler.paddingTop - tv.top - tv.paddingTop + 1
    if (y <= 0) return 0
    return layout.getLineStart(layout.getLineForVertical(y))
  }

  private fun sample(phase: Int) {
    if (tracker == 0L || snapshot == 0L || blockCount == 0) return
    val insertKeys = ArrayList<String>()
    val range = visibleBlocks(insertKeys) ?: return
    val ev = ReaderViewNative.nativeTrackerSample(tracker, range[0], range[1], phase)
    var k = 0
    while (k + 5 < ev.size) {
      when (ev[k]) {
        0 -> {
          val f = ev[k + 1]
          val l = ev[k + 2]
          val settled = ev[k + 3] == 1
          ReaderEvents.dispatch(this, ReaderEvents.VISIBLE_RANGE) {
            putString("firstSectionId", sectionIdOf(f))
            putString("firstBlockId", blockIdOf(f))
            putString("lastSectionId", sectionIdOf(l))
            putString("lastBlockId", blockIdOf(l))
            putInt("firstOffset", if (settled) firstVisibleOffset(f) else 0)
            putBoolean("settled", settled)
            putArray("visibleInsertKeys", Arguments.createArray().apply { insertKeys.forEach { pushString(it) } })
          }
        }
        1 ->
          ReaderEvents.dispatch(this, ReaderEvents.FURTHEST) {
            putString("sectionId", sectionIdOf(ev[k + 1]))
            putString("blockId", blockIdOf(ev[k + 1]))
            putInt("offset", -1)
          }
        2 ->
          ReaderEvents.dispatch(this, ReaderEvents.SECTION_END) {
            putString("sectionId", sectionIdOf(ev[k + 1]))
            putString("blockId", blockIdOf(ev[k + 1]))
          }
        3 ->
          ReaderEvents.dispatch(this, ReaderEvents.JUMP) {
            putString("fromSectionId", sectionIdOf(ev[k + 1]))
            putString("fromBlockId", blockIdOf(ev[k + 1]))
            putString("toSectionId", sectionIdOf(ev[k + 2]))
            putString("toBlockId", blockIdOf(ev[k + 2]))
            putInt("distance", ev[k + 3])
            putString(
              "cause",
              when (ev[k + 4]) {
                1 -> "fling"
                2 -> "scrollTo"
                else -> "scroll"
              },
            )
          }
      }
      k += 6
    }
  }

  private fun blockIdOf(i: Int) = ReaderViewNative.nativeBlockId(snapshot, i) ?: ""

  private fun sectionIdOf(i: Int) = ReaderViewNative.nativeSectionId(snapshot, blockSection(i)) ?: ""

  private fun dispatchError(code: String, message: String) {
    ReaderEvents.dispatch(this, ReaderEvents.ERROR) {
      putString("code", code)
      putString("message", message)
    }
  }

  private fun handleTap(e: MotionEvent) {
    val child = recycler.findChildViewUnder(e.x, e.y) ?: return
    val row = rows.getOrNull(recycler.getChildAdapterPosition(child)) as? Row.Block ?: return
    ReaderEvents.dispatch(this, ReaderEvents.TAP) { putString("blockId", row.id) }
  }

  // ---- Commands ----

  /** Puts `block` (and the line holding `offset`) at the top; finishes after layout. */
  private fun scrollToBlock(block: Int, offset: Int, sampleAfter: Boolean) {
    val row = rowOfBlock(block)
    if (row < 0) return
    recycler.stopScroll()
    programmaticScroll = false
    pendingScroll = PendingScroll(row, offset, sampleAfter)
    layoutManager.scrollToPositionWithOffset(row, 0)
  }

  internal fun scrollToLocator(sectionId: String, blockId: String, offset: Int, animated: Boolean) {
    if (snapshot == 0L) return
    var block = ReaderViewNative.nativeBlockIndex(snapshot, blockId)
    if (block < 0) {
      val s = ReaderViewNative.nativeSectionIndex(snapshot, sectionId)
      if (s >= 0 && sectionBlockCount(s) > 0) block = sectionFirstBlock(s)
    }
    if (block < 0) {
      dispatchError("ERR_READER_INVALID_ARGUMENT", "Unknown locator: $blockId")
      return
    }
    if (animated && offset <= 0) {
      val row = rowOfBlock(block)
      if (row < 0) return
      programmaticScroll = true
      val scroller =
        object : LinearSmoothScroller(context) {
          override fun getVerticalSnapPreference() = SNAP_TO_START
        }
      scroller.targetPosition = row
      layoutManager.startSmoothScroll(scroller)
      return
    }
    scrollToBlock(block, offset, sampleAfter = true)
  }

  /** Called by the manager when Fabric drops the view. */
  internal fun dispose() {
    removeCallbacks(afterLayout)
    releaseSnapshot()
    textCache.evictAll()
    blockTable = IntArray(0)
    sectionTable = IntArray(0)
  }

  // Fabric lays out this view; make sure the RecyclerView follows.
  override fun requestLayout() {
    super.requestLayout()
    if (isAttachedToWindow) post(measureAndLayout)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    post(measureAndLayout)
  }

  override fun onDetachedFromWindow() {
    // A detached view (screen popped, activity recreated) must not lay out its
    // RecyclerView from a pending callback.
    removeCallbacks(measureAndLayout)
    removeCallbacks(syncOrigins)
    removeCallbacks(afterLayout)
    super.onDetachedFromWindow()
  }

  private val measureAndLayout = Runnable {
    if (!isAttachedToWindow || width == 0 || height == 0) return@Runnable
    measure(
      MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY),
    )
    layout(left, top, right, bottom)
  }

  /**
   * Hands a native drag over to RN: once the list starts scrolling, the JS
   * responder (e.g. a Pressable inside an insert) gets a cancel.
   */
  private class ReaderRecyclerView(context: Context) : RecyclerView(context) {
    private var nativeGesture = false
    var onLayoutDone: (() -> Unit)? = null

    // react-native-screens calls startViewTransition on every descendant while a
    // screen is popped. A RecyclerView must be able to remove its own rows
    // (otherwise they stay "disappearing", keep their parent, and recycling
    // throws), so rows never take part in such a transition.
    override fun startViewTransition(view: View) = Unit

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
      super.onLayout(changed, l, t, r, b)
      onLayoutDone?.invoke()
    }

    override fun onInterceptTouchEvent(e: MotionEvent): Boolean {
      val intercept = super.onInterceptTouchEvent(e)
      if (intercept && !nativeGesture) {
        NativeGestureUtil.notifyNativeGestureStarted(this, e)
        nativeGesture = true
      }
      return intercept
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
      if (scrollState == SCROLL_STATE_DRAGGING && !nativeGesture) {
        NativeGestureUtil.notifyNativeGestureStarted(this, e)
        nativeGesture = true
      }
      if (e.actionMasked == MotionEvent.ACTION_UP || e.actionMasked == MotionEvent.ACTION_CANCEL) {
        if (nativeGesture) NativeGestureUtil.notifyNativeGestureEnded(this, e)
        nativeGesture = false
      }
      return super.onTouchEvent(e)
    }
  }

  /** Row container that lays out its insert host with the size Yoga computed. */
  private class InsertContainer(context: Context) : FrameLayout(context) {
    var host: SherpaReaderInsertView? = null

    // See ReaderRecyclerView: the host must really leave when it is moved.
    override fun startViewTransition(view: View) = Unit

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
      val h = host
      if (h == null || h.parent !== this) {
        setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), 0)
        return
      }
      val w = if (h.yogaWidth > 0) h.yogaWidth else MeasureSpec.getSize(widthMeasureSpec)
      h.measure(
        MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY),
        MeasureSpec.makeMeasureSpec(h.yogaHeight, MeasureSpec.EXACTLY),
      )
      setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), h.yogaHeight)
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
      val h = host ?: return
      if (h.parent === this) h.layout(0, 0, h.measuredWidth, h.measuredHeight)
    }
  }

  /** A short centered rule. */
  private class SeparatorView(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

    fun setLineColor(color: Int) {
      paint.color = Color.argb(90, Color.red(color), Color.green(color), Color.blue(color))
      invalidate()
    }

    override fun onDraw(canvas: Canvas) {
      val half = PixelUtil.toPixelFromDIP(40f)
      val cx = width / 2f
      val cy = height / 2f
      canvas.drawRect(cx - half, cy, cx + half, cy + max(1f, PixelUtil.toPixelFromDIP(1f)), paint)
    }
  }

  private class TextHolder(val text: TextView) : RecyclerView.ViewHolder(text)

  private class ImageHolder(val frame: OfflineImageBufferFrameView) : RecyclerView.ViewHolder(frame)

  private class SeparatorHolder(val line: SeparatorView) : RecyclerView.ViewHolder(line)

  private class InsertHolder(val container: InsertContainer) : RecyclerView.ViewHolder(container)

  private inner class Adapter : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
    // No stable IDs: rows are matched by DiffUtil (block ID / insert key).
    override fun getItemCount(): Int = rows.size

    override fun getItemViewType(position: Int): Int =
      when (val r = rows[position]) {
        is Row.Insert -> VIEW_INSERT
        is Row.Block ->
          when (blockType(r.index)) {
            TYPE_IMAGE -> VIEW_IMAGE
            TYPE_SEPARATOR -> VIEW_SEPARATOR
            else -> VIEW_TEXT
          }
      }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
      val lp = RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
      return when (viewType) {
        VIEW_IMAGE ->
          ImageHolder(
            OfflineImageBufferFrameView(reactContext).apply {
              layoutParams = lp
              setResizeMode("contain")
              adjustViewBounds = false
            }
          )
        VIEW_SEPARATOR -> SeparatorHolder(SeparatorView(parent.context).apply { layoutParams = lp })
        VIEW_INSERT -> InsertHolder(InsertContainer(parent.context).apply { layoutParams = lp })
        else ->
          TextHolder(
            TextView(parent.context).apply {
              layoutParams = lp
              includeFontPadding = false
            }
          )
      }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
      val t = theme
      when (val r = rows[position]) {
        is Row.Insert -> bindInsert(holder as InsertHolder, r)
        is Row.Block ->
          when (holder) {
            is TextHolder -> bindText(holder, r.index, t)
            is ImageHolder -> bindImage(holder, r.index, t)
            is SeparatorHolder -> {
              holder.line.setLineColor(t.textColor)
              holder.line.layoutParams.height = ceil(t.fontSizePx * 1.2f * 1.5f).toInt()
              holder.line.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            }
          }
      }
    }

    private fun bindText(holder: TextHolder, index: Int, t: Theme) {
      val tv = holder.text
      val level = if (blockType(index) == TYPE_HEADING) blockLevel(index) else 0
      val scale = if (level > 0) HEADING_SCALE[min(level, 6)] else 1f
      tv.setTextSize(TypedValue.COMPLEX_UNIT_PX, t.fontSizePx * scale)
      tv.typeface = if (level > 0) Typeface.create(t.typeface, Typeface.BOLD) else t.typeface
      tv.setLineSpacing(0f, t.lineHeight)
      tv.setTextColor(t.textColor)
      tv.setPadding(
        t.marginHorizontalPx,
        if (level > 0) t.paragraphSpacingPx else 0,
        t.marginHorizontalPx,
        t.paragraphSpacingPx,
      )
      tv.hyphenationFrequency =
        if (t.hyphenation && level == 0) Layout.HYPHENATION_FREQUENCY_NORMAL else Layout.HYPHENATION_FREQUENCY_NONE
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        tv.justificationMode =
          if (t.justify && level == 0) Layout.JUSTIFICATION_MODE_INTER_WORD else Layout.JUSTIFICATION_MODE_NONE
      }
      tv.textLocale = locale ?: Locale.getDefault()
      tv.text = blockText(index)
      ViewCompat.setAccessibilityHeading(tv, level > 0)
    }

    private fun bindImage(holder: ImageHolder, index: Int, t: Theme) {
      val v = holder.frame
      val frame = blockFrame(index)
      val w = blockTable[index * 6 + 4]
      val h = blockTable[index * 6 + 5]
      val avail = if (recycler.width > 0) recycler.width else resources.displayMetrics.widthPixels
      val viewport = if (recycler.height > 0) recycler.height else resources.displayMetrics.heightPixels
      val width = max(1, avail - 2 * t.marginHorizontalPx)
      val height = if (frame >= 0 && w > 0 && h > 0) min(width.toFloat() * h / w, viewport * 0.9f) else 0f
      v.layoutParams.height = if (height > 0) ceil(height + 1.5f * t.paragraphSpacingPx).toInt() else 0
      v.setPadding(t.marginHorizontalPx, t.paragraphSpacingPx / 2, t.marginHorizontalPx, t.paragraphSpacingPx)
      v.setMaxSide(2048)
      v.setFrameIndex(max(0, frame))
      v.setBufferId(if (frame >= 0) imageBufferId else null)
      val alt = ReaderViewNative.nativeBlockAlt(snapshot, index)
      v.contentDescription = alt
      // Images without alt text are decorative: hidden from TalkBack.
      v.importantForAccessibility =
        if (alt.isNullOrEmpty()) View.IMPORTANT_FOR_ACCESSIBILITY_NO else View.IMPORTANT_FOR_ACCESSIBILITY_YES
    }

    private fun bindInsert(holder: InsertHolder, r: Row.Insert) {
      val container = holder.container
      val host = hostFor(r.key)
      if (container.host !== host || host?.parent !== container) {
        container.removeAllViews()
        container.host = host
        if (host != null) {
          (host.parent as? ViewGroup)?.removeView(host)
          container.addView(host)
        }
      }
      container.requestLayout()
    }

    override fun onViewRecycled(holder: RecyclerView.ViewHolder) {
      if (holder is InsertHolder) {
        holder.container.removeAllViews()
        holder.container.host = null
      }
    }
  }

  companion object {
    private const val TYPE_HEADING = 1
    private const val TYPE_IMAGE = 2
    private const val TYPE_SEPARATOR = 3

    private const val VIEW_TEXT = 0
    private const val VIEW_IMAGE = 1
    private const val VIEW_SEPARATOR = 2
    private const val VIEW_INSERT = 3

    private val HEADING_SCALE = floatArrayOf(1f, 1.6f, 1.35f, 1.2f, 1.1f, 1.05f, 1f)
  }
}
