package com.sherpaonnx.reader

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.Configuration
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Typeface
import android.os.Build
import android.os.SystemClock
import android.text.Layout
import android.text.Selection
import android.text.Spannable
import android.text.SpannableString
import android.text.Spanned
import android.text.TextPaint
import android.text.style.BackgroundColorSpan
import android.text.style.CharacterStyle
import android.text.style.ForegroundColorSpan
import android.text.style.MetricAffectingSpan
import android.text.style.UpdateAppearance
import android.util.LruCache
import android.util.TypedValue
import android.view.ActionMode
import android.view.GestureDetector
import android.view.Menu
import android.view.MenuItem
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
import kotlin.math.abs
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
    /** Shows block [index]; stands for blocks [coverFirst, coverLast] (see ReaderLayout.h). */
    data class Block(
      val id: String,
      val index: Int,
      val coverFirst: Int = index,
      val coverLast: Int = index,
      val page: Boolean = false,
    ) : Row()

    data class Insert(val key: String) : Row()
  }

  /** Theme resolved to pixels. */
  private data class Theme(
    val fontSizePx: Float,
    val typeface: Typeface,
    /** Faces for inline styles, indexed by flags (1 italic, 2 bold, 3 both); [0] = [typeface]. */
    val styledFaces: List<Typeface>,
    val lineHeight: Float,
    val paragraphSpacingPx: Int,
    val marginHorizontalPx: Int,
    val marginVerticalPx: Int,
    val justify: Boolean,
    val hyphenation: Boolean,
    val textColor: Int,
    val accentColor: Int,
  )

  /** One `highlights` prop entry (style 0 background, 1 underline, 2 text color). */
  private data class HighlightSpec(
    val id: String,
    val fromBlockId: String,
    val fromOffset: Int,
    val toBlockId: String,
    val toOffset: Int,
    val style: Int,
    val color: Int,
    val hasColor: Boolean,
    val follow: Boolean,
  )

  /** One `markers` prop entry (start / end -1: the whole block). */
  private data class MarkerSpec(val id: String, val blockId: String, val start: Int, val end: Int)

  /** A resolved marker: its spec and the UTF-16 offset whose line it sits at (-1: the first line). */
  private data class Marker(val spec: MarkerSpec, val offset: Int)

  /** One `selectionMenuItems` entry (`systemImage` is iOS only). */
  private data class MenuItemSpec(val id: String, val title: String)

  /** Resolved part of a highlight inside one block (UTF-16 range of the block text). */
  private data class Span(val start: Int, val end: Int, val style: Int, val color: Int, val hasColor: Boolean)

  /** A scroll to a block that finishes after the next layout pass(es). */
  private class PendingScroll(
    val row: Int,
    val offset: Int,
    val sampleAfter: Boolean,
    val followAfter: Boolean = false,
  ) {
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
  private var accentColor: Int? = null
  private var highlightSpecs: List<HighlightSpec> = emptyList()
  private var highlightsDirty = false
  private var followMode = "keepVisible"
  private var followAnchor = 0.3f
  private var followPauseOnUser = true
  private var pageDisplay = "text"
  private var selectable = false
  private var selectionSnap = ReaderViewNative.SNAP_NONE
  private var menuItems: List<MenuItemSpec> = emptyList()
  private var markerSpecs: List<MarkerSpec> = emptyList()
  private var markersDirty = false

  /** Logical React children (insert and marker hosts), in Fabric's order. Not attached to this view. */
  internal val hosts = mutableListOf<SherpaReaderInsertView>()

  /** Mounted marker hosts, placed over the rows (see [positionMarkers]). */
  private val markerLayer = MarkerLayer(reactContext)

  private val recycler = ReaderRecyclerView(reactContext)
  private val layoutManager =
    object : LinearLayoutManager(reactContext) {
      // Selectable text rows take focus on a long press; the list must not
      // scroll to bring the focused row (or a selection rectangle) into view.
      override fun requestChildRectangleOnScreen(
        parent: RecyclerView,
        child: View,
        rect: Rect,
        immediate: Boolean,
        focusedChildVisible: Boolean,
      ): Boolean = false

      override fun requestChildRectangleOnScreen(
        parent: RecyclerView,
        child: View,
        rect: Rect,
        immediate: Boolean,
      ): Boolean = false
    }
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
  private val styleCache = LruCache<Int, IntArray>(256)

  private var rebuildPosted = false
  private var initialApplied = false
  private var readySent = false
  private var programmaticScroll = false
  private var pendingScroll: PendingScroll? = null
  private var pendingLayoutSample = false
  private var pendingFollowCheck = false
  private var lastOriginSync = 0L

  // ---- Highlights and follow ----
  private var spansByBlock: Map<Int, List<Span>> = emptyMap()
  private var rowByBlock = IntArray(0)
  private var followBlock = -1
  private var followOffset = 0
  private var followedBlock = -1
  private var followedOffset = 0
  private var followPaused = false
  private var followScroll = false
  private var followPlaceAfter = false
  private var reportedInvalid: List<String> = emptyList()

  // ---- Selection and markers ----
  private var markersByBlock: Map<Int, List<Marker>> = emptyMap()
  private var reportedInvalidMarkers: List<String> = emptyList()
  /** Last `onMarkerWindowChange`: the rows it was computed for and its IDs. */
  private var markerWindowFirst = -1
  private var markerWindowLast = -1
  private var markerWindow: List<String> = emptyList()
  /** The text view holding the current selection (one at a time; v1: within one block). */
  private var selectionView: ReaderTextView? = null

  init {
    recycler.layoutManager = layoutManager
    recycler.adapter = adapter
    recycler.itemAnimator = null
    recycler.clipToPadding = false
    recycler.onLayoutDone = {
      positionMarkers()
      if (pendingScroll != null || pendingLayoutSample || pendingFollowCheck) post(afterLayout)
      post(markerWindowCheck)
    }
    addView(recycler, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    addView(markerLayer, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    recycler.addOnScrollListener(
      object : RecyclerView.OnScrollListener() {
        override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) {
          when (rv.scrollState) {
            RecyclerView.SCROLL_STATE_DRAGGING -> sample(ReaderViewNative.PHASE_DRAG)
            RecyclerView.SCROLL_STATE_SETTLING ->
              when {
                followScroll -> sample(ReaderViewNative.PHASE_FOLLOW)
                !programmaticScroll -> sample(ReaderViewNative.PHASE_MOMENTUM)
              }
          }
          // Same frame as the row offsets: marker views move with their rows.
          positionMarkers()
          updateMarkerWindow(force = false)
          // Throttled: Pressability measures on touch-down; at rest the sync is exact.
          if (SystemClock.uptimeMillis() - lastOriginSync > 50) syncInsertOrigins(markers = false)
        }

        override fun onScrollStateChanged(rv: RecyclerView, newState: Int) {
          when (newState) {
            RecyclerView.SCROLL_STATE_DRAGGING -> {
              programmaticScroll = false
              followScroll = false
              if (followPauseOnUser && !followPaused && followBlock >= 0 && followMode != "off") {
                followPaused = true
                dispatchFollowChange(false, "user")
              }
            }
            RecyclerView.SCROLL_STATE_SETTLING ->
              if (!programmaticScroll && !followScroll) sample(ReaderViewNative.PHASE_MOMENTUM)
            RecyclerView.SCROLL_STATE_IDLE -> {
              syncInsertOrigins()
              if (programmaticScroll) {
                programmaticScroll = false
                sample(ReaderViewNative.PHASE_PROGRAMMATIC)
              }
              if (followScroll) {
                followScroll = false
                sample(ReaderViewNative.PHASE_FOLLOW)
              }
              sample(ReaderViewNative.PHASE_IDLE)
              // The user scrolled the followed highlight back into the comfort zone.
              if (followPaused && followInComfortZone()) {
                followPaused = false
                dispatchFollowChange(true, "resumed")
              }
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
            // A tap while text is selected only ends the selection (the text view clears it).
            val selected = selectionView
            if (selected != null && selected.hasSelection()) {
              selected.clearSelection()
              selectionView = null
              return false
            }
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
    // Rows can change (OCR text in place of a page image): keep the reading
    // position. While the user scrolls, the list keeps its own position.
    if (pendingAnchor == null && recycler.scrollState == RecyclerView.SCROLL_STATE_IDLE) {
      pendingAnchor = readingAnchor()
    }
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

  internal fun setAccentColor(v: Int?) {
    accentColor = v
  }

  internal fun setHighlights(value: ReadableArray?) {
    val next = ArrayList<HighlightSpec>()
    if (value != null) {
      for (i in 0 until value.size()) {
        val m = value.getMap(i) ?: continue
        next +=
          HighlightSpec(
            id = m.getString("id") ?: "",
            fromBlockId = m.getString("fromBlockId") ?: "",
            fromOffset = if (m.hasKey("fromOffset")) m.getInt("fromOffset") else -1,
            toBlockId = m.getString("toBlockId") ?: "",
            toOffset = if (m.hasKey("toOffset")) m.getInt("toOffset") else -1,
            style =
              when (m.getString("style")) {
                "underline" -> 1
                "textColor" -> 2
                else -> 0
              },
            color = if (m.hasKey("color")) m.getInt("color") else 0,
            hasColor = m.hasKey("hasColor") && m.getBoolean("hasColor"),
            follow = m.hasKey("follow") && m.getBoolean("follow"),
          )
      }
    }
    if (next != highlightSpecs) {
      highlightSpecs = next
      highlightsDirty = true
    }
  }

  private var followModeDirty = false

  internal fun setFollowMode(v: String?) {
    val mode = v ?: "keepVisible"
    if (mode == followMode) return
    followMode = mode
    followModeDirty = true
    if (mode == "off") followPaused = false
  }

  internal fun setFollowAnchor(v: Float) {
    followAnchor = v.coerceIn(0f, 1f)
  }

  internal fun setFollowPauseOnUserScroll(v: Boolean) {
    followPauseOnUser = v
  }

  internal fun setPageDisplay(v: String?) {
    val mode = if (v == "image" || v == "imageAndText") v else "text"
    if (mode == pageDisplay) return
    if (pendingAnchor == null) pendingAnchor = readingAnchor()
    pageDisplay = mode
    scheduleRebuild()
  }

  internal fun setSelectable(v: Boolean) {
    if (v == selectable) return
    selectable = v
    if (!v) selectionView?.clearSelection()
    for (c in 0 until recycler.childCount) {
      (recycler.getChildViewHolder(recycler.getChildAt(c)) as? TextHolder)?.text?.setSelectableText(v)
    }
  }

  internal fun setSelectionSnap(v: String?) {
    selectionSnap =
      when (v) {
        "sentence" -> ReaderViewNative.SNAP_SENTENCE
        "block" -> ReaderViewNative.SNAP_BLOCK
        else -> ReaderViewNative.SNAP_NONE
      }
  }

  internal fun setSelectionMenuItems(value: ReadableArray?) {
    val next = ArrayList<MenuItemSpec>()
    if (value != null) {
      for (i in 0 until value.size()) {
        val m = value.getMap(i) ?: continue
        next += MenuItemSpec(m.getString("id") ?: "", m.getString("title") ?: "")
      }
    }
    menuItems = next
  }

  internal fun setMarkers(value: ReadableArray?) {
    val next = ArrayList<MarkerSpec>()
    if (value != null) {
      for (i in 0 until value.size()) {
        val m = value.getMap(i) ?: continue
        next +=
          MarkerSpec(
            id = m.getString("id") ?: "",
            blockId = m.getString("blockId") ?: "",
            start = if (m.hasKey("start")) m.getInt("start") else -1,
            end = if (m.hasKey("end")) m.getInt("end") else -1,
          )
      }
    }
    if (next != markerSpecs) {
      markerSpecs = next
      markersDirty = true
    }
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
    if (markersDirty && !rebuildPosted) {
      // A pending rebuild resolves markers itself.
      markersDirty = false
      applyMarkers()
    }
    if (highlightsDirty && !rebuildPosted) {
      // A pending rebuild resolves highlights itself.
      highlightsDirty = false
      applyHighlights()
    } else if (followModeDirty && !rebuildPosted) {
      follow(animated = true, force = true)
    }
    followModeDirty = false
  }

  // ---- Highlights and follow ----

  /** Resolves `highlightSpecs` against the snapshot; returns blocks whose spans changed. */
  private fun resolveHighlights(): Set<Int> {
    val specs = highlightSpecs
    val next = HashMap<Int, List<Span>>()
    var fb = -1
    var fo = 0
    val invalid = ArrayList<String>()
    if (snapshot != 0L && specs.isNotEmpty()) {
      val packed =
        ReaderViewNative.nativeResolveHighlights(
          snapshot,
          Array(specs.size) { specs[it].id },
          Array(specs.size) { specs[it].fromBlockId },
          IntArray(specs.size) { specs[it].fromOffset },
          Array(specs.size) { specs[it].toBlockId },
          IntArray(specs.size) { specs[it].toOffset },
          IntArray(specs.size) { specs[it].style },
          IntArray(specs.size) { specs[it].color },
          IntArray(specs.size) { (if (specs[it].hasColor) 1 else 0) or (if (specs[it].follow) 2 else 0) },
        )
      if (packed.size >= 3) {
        fb = packed[0]
        fo = packed[1]
        val nInvalid = packed[2]
        var k = 3
        repeat(nInvalid) { invalid += specs.getOrNull(packed[k++])?.id ?: "" }
        while (k + 1 < packed.size) {
          val block = packed[k]
          val n = packed[k + 1]
          k += 2
          val list = ArrayList<Span>(n)
          repeat(n) {
            list += Span(packed[k], packed[k + 1], packed[k + 2], packed[k + 3], packed[k + 4] == 1)
            k += 5
          }
          next[block] = list
        }
      }
    }
    val changed = HashSet<Int>()
    for ((block, spans) in next) if (spansByBlock[block] != spans) changed += block
    for (block in spansByBlock.keys) if (block !in next) changed += block
    spansByBlock = next
    followBlock = fb
    followOffset = fo
    if (invalid.isNotEmpty() && invalid != reportedInvalid) {
      dispatchError("ERR_READER_INVALID_ARGUMENT", "Unknown highlight range: ${invalid.joinToString()}")
    }
    reportedInvalid = invalid
    return changed
  }

  /** Re-applies changed highlights to their rows (spans only), then follows. */
  private fun applyHighlights() {
    for (block in resolveHighlights()) {
      val row = rowByBlock.getOrElse(block) { -1 }
      if (row >= 0) adapter.notifyItemChanged(row, PAYLOAD_HIGHLIGHT)
    }
    follow(animated = true, force = false)
  }

  private fun dispatchFollowChange(following: Boolean, reason: String) {
    ReaderEvents.dispatch(this, ReaderEvents.FOLLOW_CHANGE) {
      putBoolean("following", following)
      putString("reason", reason)
    }
  }

  /** Top and height of the followed highlight's first line (recycler coordinates), or null if not laid out. */
  private fun followLine(): IntArray? {
    if (followBlock < 0) return null
    val row = rowByBlock.getOrElse(followBlock) { -1 }
    if (row < 0) return null
    val holder = recycler.findViewHolderForAdapterPosition(row) ?: return null
    val item = holder.itemView
    val r = rows.getOrNull(row) as? Row.Block
    if (r != null && r.page && r.index != followBlock) {
      // On a page image: the followed text's line on the page.
      val rects = ReaderViewNative.nativeTextRangeRects(snapshot, followBlock, followOffset, followOffset + 1)
      if (rects.size >= 4) {
        return intArrayOf(item.top + (rects[1] * item.height).toInt(), max(1, (rects[3] * item.height).toInt()))
      }
    }
    val tv = (holder as? TextHolder)?.text
    val layout = tv?.layout
    if (tv == null || layout == null) return intArrayOf(item.top, min(item.height, (theme.fontSizePx * theme.lineHeight).toInt()))
    val line = layout.getLineForOffset(min(followOffset, tv.text.length))
    val top = item.top + tv.paddingTop + layout.getLineTop(line)
    return intArrayOf(top, layout.getLineBottom(line) - layout.getLineTop(line))
  }

  /** True when the followed line lies in the comfort zone (10 %–85 % of the height). */
  private fun followInComfortZone(): Boolean {
    val line = followLine() ?: return false
    val h = recycler.height
    return line[0] >= 0.10f * h && line[0] + line[1] <= 0.85f * h
  }

  /**
   * Keeps the followed highlight in view. `force` re-checks even if the
   * highlight did not move (mode change, reflow); `place` moves it to the
   * anchor even when it is already in the comfort zone (resumeFollow).
   */
  private fun follow(animated: Boolean, force: Boolean, place: Boolean = false) {
    if (snapshot == 0L || followBlock < 0) {
      followedBlock = -1
      return
    }
    val moved = followBlock != followedBlock || followOffset != followedOffset
    followedBlock = followBlock
    followedOffset = followOffset
    if ((!moved && !force) || followMode == "off") return
    if (recycler.scrollState == RecyclerView.SCROLL_STATE_DRAGGING) return
    if (followPaused) {
      if (!followInComfortZone()) return
      followPaused = false
      dispatchFollowChange(true, "resumed")
    }
    val line = followLine()
    if (line == null) {
      // Far away (row not laid out): jump there first, then place it exactly.
      val row = rowByBlock.getOrElse(followBlock) { -1 }
      if (row < 0) return
      recycler.stopScroll()
      programmaticScroll = false
      followScroll = false
      pendingScroll = PendingScroll(row, followOffset, sampleAfter = false, followAfter = true)
      followPlaceAfter = place
      layoutManager.scrollToPositionWithOffset(row, 0)
      return
    }
    val h = recycler.height
    val dy =
      if (followMode == "center") {
        line[0] + line[1] / 2 - h / 2
      } else {
        if (!place && line[0] >= 0.10f * h && line[0] + line[1] <= 0.85f * h) {
          if (!animated) sample(ReaderViewNative.PHASE_FOLLOW)
          return
        }
        line[0] - (followAnchor * h).toInt()
      }
    if (abs(dy) < 1) {
      if (!animated) sample(ReaderViewNative.PHASE_FOLLOW)
      return
    }
    if (animated) {
      followScroll = true
      recycler.smoothScrollBy(0, dy)
    } else {
      recycler.scrollBy(0, dy)
      syncInsertOrigins()
      sample(ReaderViewNative.PHASE_FOLLOW)
      sample(ReaderViewNative.PHASE_IDLE)
    }
  }

  internal fun resumeFollow() {
    if (followPaused) {
      followPaused = false
      dispatchFollowChange(true, "command")
    }
    follow(animated = true, force = true, place = true)
  }

  // ---- Markers ----

  /** Resolves `markerSpecs` against the snapshot; returns blocks whose markers changed. */
  private fun resolveMarkers(): Set<Int> {
    val specs = markerSpecs
    val next = HashMap<Int, ArrayList<Marker>>()
    val invalid = ArrayList<String>()
    if (snapshot != 0L && specs.isNotEmpty()) {
      val packed =
        ReaderViewNative.nativeResolveMarkers(
          snapshot,
          Array(specs.size) { specs[it].id },
          Array(specs.size) { specs[it].blockId },
          IntArray(specs.size) { specs[it].start },
          IntArray(specs.size) { specs[it].end },
        )
      if (packed.isNotEmpty()) {
        var k = 1
        repeat(packed[0]) { invalid += specs.getOrNull(packed[k++])?.id ?: "" }
        while (k + 2 < packed.size) {
          val spec = specs.getOrNull(packed[k + 1])
          if (spec != null) next.getOrPut(packed[k]) { ArrayList() } += Marker(spec, packed[k + 2])
          k += 3
        }
      }
    }
    val changed = HashSet<Int>()
    for ((block, list) in next) if (markersByBlock[block] != list) changed += block
    for (block in markersByBlock.keys) if (block !in next) changed += block
    markersByBlock = next
    if (invalid.isNotEmpty() && invalid != reportedInvalidMarkers) {
      dispatchError("ERR_READER_INVALID_ARGUMENT", "Unknown marker block or range: ${invalid.joinToString()}")
    }
    reportedInvalidMarkers = invalid
    return changed
  }

  /** Re-places the marker views and tells JS which ones to mount. */
  private fun applyMarkers() {
    resolveMarkers()
    updateMarkerWindow(force = true)
    positionMarkers()
  }

  /** Markers of the blocks a row stands for, with the block each belongs to. */
  private fun markersOfRow(r: Row.Block): List<Pair<Int, Marker>> {
    if (markersByBlock.isEmpty()) return emptyList()
    val out = ArrayList<Pair<Int, Marker>>()
    for (block in r.coverFirst..r.coverLast) markersByBlock[block]?.forEach { out += block to it }
    return out
  }

  private fun markerHostFor(id: String): SherpaReaderInsertView? =
    hosts.firstOrNull { it.markerId == id && it.parent === markerLayer }

  /**
   * Tells JS which marker views to mount: the markers of the visible rows and
   * as many rows again above and below. Emitted only when that set changes;
   * while the rows stay the same nothing is computed.
   */
  private fun updateMarkerWindow(force: Boolean) {
    if (markerWindow.isEmpty() && markersByBlock.isEmpty()) return
    var first = -1
    var last = -1
    if (markersByBlock.isNotEmpty() && rows.isNotEmpty()) {
      val f = layoutManager.findFirstVisibleItemPosition()
      val l = layoutManager.findLastVisibleItemPosition()
      if (f >= 0 && l >= f) {
        val extra = l - f + 1
        first = max(0, f - extra)
        last = min(rows.size - 1, l + extra)
      }
    }
    if (!force && first == markerWindowFirst && last == markerWindowLast) return
    markerWindowFirst = first
    markerWindowLast = last
    val ids = ArrayList<String>()
    if (first >= 0) {
      for (i in first..last) {
        val r = rows[i] as? Row.Block ?: continue
        for ((_, m) in markersOfRow(r)) ids += m.spec.id
      }
    }
    if (ids == markerWindow) return
    markerWindow = ids
    ReaderEvents.dispatch(this, ReaderEvents.MARKER_WINDOW) {
      putArray("markerIds", Arguments.createArray().apply { ids.forEach { pushString(it) } })
    }
  }

  private val markerWindowCheck = Runnable { if (isAttachedToWindow) updateMarkerWindow(force = false) }

  /**
   * Places the mounted marker views over their rows: in the trailing margin,
   * vertically centered on the line each sits at (markers on the same line go
   * below one another). Views of rows that are not attached are hidden. Runs
   * after every scroll step and layout pass, so the views move with the rows.
   */
  private fun positionMarkers() {
    if (markerLayer.childCount == 0) return
    val placed = HashSet<View>()
    if (markersByBlock.isNotEmpty()) {
      val t = theme
      val gap = PixelUtil.toPixelFromDIP(2f)
      val width = recycler.width.toFloat()
      for (i in 0 until recycler.childCount) {
        val child = recycler.getChildAt(i)
        val r = rows.getOrNull(recycler.getChildAdapterPosition(child)) as? Row.Block ?: continue
        val markers = markersOfRow(r)
        if (markers.isEmpty()) continue
        val holder = recycler.getChildViewHolder(child)
        val top = child.top + child.translationY
        val inset = if (r.page) 0f else t.marginHorizontalPx.toFloat()
        val withHosts =
          markers.mapNotNull { (block, m) ->
            val host = markerHostFor(m.spec.id) ?: return@mapNotNull null
            if (host.yogaWidth <= 0 || host.yogaHeight <= 0) return@mapNotNull null
            Triple(host, centerOf(holder, r, block, m, top, host.yogaHeight.toFloat()), host.yogaHeight.toFloat())
          }.sortedBy { it.second }
        var lastBottom = Float.NEGATIVE_INFINITY
        for ((host, center, h) in withHosts) {
          val w = host.yogaWidth.toFloat()
          val cy = max(center, lastBottom + gap + h / 2)
          // Centered in the margin; a view wider than the margin stays inside
          // the row (it then overlaps the text).
          var x = if (inset > 0) width - inset / 2 - w / 2 else width - w
          x = max(0f, min(x, width - w))
          val y = cy - h / 2
          if (host.translationX != x) host.translationX = x
          if (host.translationY != y) host.translationY = y
          if (host.visibility != View.VISIBLE) host.visibility = View.VISIBLE
          lastBottom = y + h
          placed += host
        }
      }
    }
    for (i in 0 until markerLayer.childCount) {
      val host = markerLayer.getChildAt(i)
      if (host !in placed && host.visibility != View.INVISIBLE) host.visibility = View.INVISIBLE
    }
  }

  /** Vertical center (recycler coordinates) of the line a marker sits at; `height`: the marker view's. */
  private fun centerOf(holder: RecyclerView.ViewHolder, r: Row.Block, block: Int, m: Marker, top: Float, height: Float): Float {
    if (holder is TextHolder && block == r.index && !r.page) {
      val tv = holder.text
      val layout = tv.layout ?: return top + height / 2
      val line = if (m.offset < 0) 0 else layout.getLineForOffset(min(m.offset, tv.text.length))
      val fm = tv.paint.fontMetrics
      return top + tv.paddingTop + layout.getLineBaseline(line) + (fm.ascent + fm.descent) / 2
    }
    val item = holder.itemView
    if (r.page || block != r.index) {
      val pr = ReaderViewNative.nativeMarkerPageRect(snapshot, block, m.offset)
      if (pr.size >= 4 && pr[3] > 0) return top + (pr[1] + pr[3] / 2) * item.height
      if (pr.size >= 4) return top + pr[1] * item.height + height / 2 + PixelUtil.toPixelFromDIP(4f)
    }
    val padTop = (holder as? ImageHolder)?.frame?.paddingTop ?: 0
    return top + padTop + height / 2 + PixelUtil.toPixelFromDIP(4f)
  }

  /** A visible marker view (with its hit slop) at recycler point ([x], [y]). */
  private fun markerViewAt(x: Float, y: Float): Boolean {
    for (i in 0 until markerLayer.childCount) {
      val host = markerLayer.getChildAt(i) as? SherpaReaderInsertView ?: continue
      if (host.visibility != View.VISIBLE) continue
      val slop = host.hitSlopRect
      val l = host.translationX - (slop?.left ?: 0)
      val t = host.translationY - (slop?.top ?: 0)
      val r = host.translationX + host.width + (slop?.right ?: 0)
      val b = host.translationY + host.height + (slop?.bottom ?: 0)
      if (x >= l && x < r && y >= t && y < b) return true
    }
    return false
  }

  // ---- Selection ----

  private fun snapSelection(tv: ReaderTextView, start: Int, end: Int): IntArray? {
    if (snapshot == 0L || selectionSnap == ReaderViewNative.SNAP_NONE || tv.blockIndex < 0) return null
    return ReaderViewNative.nativeSnapRange(snapshot, tv.blockIndex, start, end, selectionSnap)
  }

  private fun dispatchSelectionAction(itemId: String, tv: ReaderTextView) {
    val block = tv.blockIndex
    val start = min(tv.selectionStart, tv.selectionEnd)
    val end = max(tv.selectionStart, tv.selectionEnd)
    if (snapshot == 0L || block < 0 || end <= start) return
    val text = blockText(block)
    if (end > text.length) return
    val sentence = ReaderViewNative.nativeSnapRange(snapshot, block, start, end, ReaderViewNative.SNAP_SENTENCE)
    ReaderEvents.dispatch(this, ReaderEvents.SELECTION_ACTION) {
      putString("itemId", itemId)
      putString("blockId", blockIdOf(block))
      putInt("start", start)
      putInt("end", end)
      putString("text", text.substring(start, end))
      putInt("sentenceStart", sentence.getOrElse(0) { start })
      putInt("sentenceEnd", sentence.getOrElse(1) { end })
    }
  }

  /** App items before the system ones (copy, share, …); a choice ends the selection. */
  private inner class SelectionCallback(private val tv: ReaderTextView) : ActionMode.Callback {
    override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
      menuItems.forEachIndexed { i, item -> menu.add(Menu.NONE, MENU_ITEM_BASE + i, i, item.title) }
      return true
    }

    override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean = false

    override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
      val i = item.itemId - MENU_ITEM_BASE
      val spec = menuItems.getOrNull(i) ?: return false
      dispatchSelectionAction(spec.id, tv)
      mode.finish()
      tv.clearSelection()
      return true
    }

    override fun onDestroyActionMode(mode: ActionMode) = Unit
  }

  /**
   * Text row. Selection (when `selectable`) is snapped while it changes;
   * `blockIndex` is the flat block index the row shows.
   */
  private inner class ReaderTextView(context: Context) : TextView(context) {
    var blockIndex = -1
    private var snapping = false

    fun setSelectableText(on: Boolean) {
      if (isTextSelectable == on) return
      setTextIsSelectable(on)
      if (!on) clearSelection()
    }

    fun clearSelection() {
      val t = text
      if (t is Spannable && hasSelection()) Selection.removeSelection(t)
      if (selectionView === this) selectionView = null
    }

    override fun onSelectionChanged(selStart: Int, selEnd: Int) {
      super.onSelectionChanged(selStart, selEnd)
      if (snapping) return
      val t = text as? Spannable ?: return
      val start = min(selStart, selEnd)
      val end = max(selStart, selEnd)
      if (end <= start) return
      val prev = selectionView
      selectionView = this
      if (prev != null && prev !== this) prev.clearSelection()
      val snapped = snapSelection(this, start, end) ?: return
      if (snapped.size == 2 && (snapped[0] != start || snapped[1] != end) && snapped[1] <= t.length) {
        snapping = true
        Selection.setSelection(t, snapped[0], snapped[1])
        snapping = false
      }
    }

    /** Re-sets the text and keeps a selection (highlight-only updates). */
    fun setTextKeepingSelection(value: CharSequence) {
      val start = selectionStart
      val end = selectionEnd
      val had = isTextSelectable && hasSelection()
      snapping = true
      text = value
      val t = text
      if (had && t is Spannable && end <= t.length) Selection.setSelection(t, start, end)
      snapping = false
    }
  }

  /** Highlights of the blocks a page row stands for, as rects on the page image. */
  private fun pageMarks(r: Row.Block, t: Theme): List<PageMark> {
    if (!r.page || r.coverLast <= r.coverFirst || spansByBlock.isEmpty()) return emptyList()
    val out = ArrayList<PageMark>()
    for (block in r.coverFirst..r.coverLast) {
      val spans = spansByBlock[block] ?: continue
      for (sp in spans) {
        val color =
          when {
            sp.hasColor -> sp.color
            sp.style == 0 -> (t.accentColor and 0x00FFFFFF) or (0x4D shl 24)
            else -> t.accentColor
          }
        val rects = ReaderViewNative.nativeTextRangeRects(snapshot, block, sp.start, sp.end)
        var k = 0
        while (k + 3 < rects.size) {
          out += PageMark(rects[k], rects[k + 1], rects[k + 2], rects[k + 3], sp.style, color)
          k += 4
        }
      }
    }
    return out
  }

  /**
   * Text with inline styles and highlight spans (colors default to the theme
   * accent). Styles are part of every bind, so the measured height includes them.
   */
  private fun styled(text: String, styles: IntArray, heading: Boolean, spans: List<Span>?, t: Theme): CharSequence {
    if (spans.isNullOrEmpty() && styles.isEmpty()) return text
    val out = SpannableString(text)
    var k = 0
    while (k + 2 < styles.size) {
      val start = styles[k].coerceIn(0, text.length)
      val end = styles[k + 1].coerceIn(start, text.length)
      // Headings are bold already: italic there means bold italic.
      val flags = (styles[k + 2] and 3) or (if (heading) 2 else 0)
      k += 3
      if (end <= start || flags == 0) continue
      out.setSpan(ReaderFaceSpan(t.styledFaces[flags], flags), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
    if (spans.isNullOrEmpty()) return out
    for (sp in spans) {
      val start = sp.start.coerceIn(0, text.length)
      val end = sp.end.coerceIn(start, text.length)
      if (end <= start) continue
      val span: Any =
        when (sp.style) {
          1 -> UnderlineColorSpan(if (sp.hasColor) sp.color else t.accentColor, PixelUtil.toPixelFromDIP(2f))
          2 -> ForegroundColorSpan(if (sp.hasColor) sp.color else t.accentColor)
          else ->
            BackgroundColorSpan(
              if (sp.hasColor) sp.color else (t.accentColor and 0x00FFFFFF) or (0x4D shl 24)
            )
        }
      out.setSpan(span, start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
    return out
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
    // Inline styles: the family's italic / bold faces (custom fonts through
    // ReactFontManager, e.g. assets/fonts/<family>_italic.ttf); a family without
    // the face falls back to a synthetic one (see ReaderFaceSpan).
    val styledFaces =
      List(4) { flags ->
        val style =
          when (flags) {
            1 -> Typeface.ITALIC
            2 -> Typeface.BOLD
            3 -> Typeface.BOLD_ITALIC
            else -> Typeface.NORMAL
          }
        if (style == Typeface.NORMAL) {
          typeface
        } else if (fontFamily.isNotEmpty()) {
          ReactFontManager.getInstance().getTypeface(fontFamily, style, reactContext.assets)
        } else {
          Typeface.create(typeface, style)
        }
      }
    return Theme(
      fontSizePx = sizePx,
      typeface = typeface,
      styledFaces = styledFaces,
      lineHeight = if (lineHeight > 0) lineHeight else 1.5f,
      paragraphSpacingPx = ((if (paragraphSpacing >= 0) paragraphSpacing else 0.75f) * sizePx).toInt(),
      marginHorizontalPx = PixelUtil.toPixelFromDIP(marginHorizontal).toInt(),
      marginVerticalPx = PixelUtil.toPixelFromDIP(marginVertical).toInt(),
      justify = justify,
      hyphenation = hyphenation,
      textColor = textColor ?: defaultTextColor,
      accentColor = accentColor ?: DEFAULT_ACCENT,
    )
  }

  // ---- Children (insert hosts) ----

  internal fun addHost(host: SherpaReaderInsertView, index: Int) {
    hosts.add(index.coerceIn(0, hosts.size), host)
    host.reader = this
    if (host.markerId.isNotEmpty()) attachMarkerHost(host) else scheduleRebuild()
  }

  internal fun removeHostAt(index: Int) {
    if (index !in hosts.indices) return
    val host = hosts.removeAt(index)
    host.reader = null
    val wasMarker = host.parent === markerLayer
    (host.parent as? ViewGroup)?.removeView(host)
    if (!wasMarker) scheduleRebuild()
  }

  /** Marker hosts live in [markerLayer], hidden until [positionMarkers] places them. */
  private fun attachMarkerHost(host: SherpaReaderInsertView) {
    if (host.parent !== markerLayer) {
      (host.parent as? ViewGroup)?.removeView(host)
      host.visibility = View.INVISIBLE
      markerLayer.addView(host)
    }
    post(placeMarkers)
  }

  private val placeMarkers =
    Runnable {
      if (isAttachedToWindow) {
        positionMarkers()
        syncInsertOrigins(markers = recycler.scrollState == RecyclerView.SCROLL_STATE_IDLE)
      }
    }

  internal fun onInsertKeyChanged(host: SherpaReaderInsertView) {
    if (host.markerId.isNotEmpty()) {
      val wasInsert = host.parent !== markerLayer
      attachMarkerHost(host)
      if (wasInsert) scheduleRebuild()
    } else {
      if (host.parent === markerLayer) markerLayer.removeView(host)
      scheduleRebuild()
    }
  }

  internal fun onInsertResized(host: SherpaReaderInsertView) {
    if (host.markerId.isNotEmpty()) {
      markerLayer.requestLayout()
      post(placeMarkers)
      return
    }
    val key = host.insertKey
    // The LinearLayoutManager keeps the first visible row in place on a change.
    post {
      val pos = rows.indexOfFirst { it is Row.Insert && it.key == key }
      if (isAttachedToWindow && pos >= 0) adapter.notifyItemChanged(pos)
    }
  }

  private fun hostFor(key: String): SherpaReaderInsertView? =
    hosts.firstOrNull { it.insertKey == key && it.markerId.isEmpty() }

  /**
   * Pushes every attached insert host's position (reader coordinates) into its
   * shadow state. Each changed origin is a Fabric state update (a commit), so
   * marker hosts (often dozens) are synced only at rest ([markers] false while
   * scrolling); Pressability inside them measures after the list has settled.
   */
  private fun syncInsertOrigins(markers: Boolean = true) {
    lastOriginSync = SystemClock.uptimeMillis()
    val loc = IntArray(2)
    val own = IntArray(2)
    getLocationInWindow(own)
    for (host in hosts) {
      val placed =
        host.parent is InsertContainer || (markers && host.parent === markerLayer && host.visibility == View.VISIBLE)
      if (!placed || !host.isAttachedToWindow) continue
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
          pendingFollowCheck = true
          recycler.requestLayout()
        }
      }
    }
    post(syncOrigins)
  }

  /** A position the reader keeps across reflows: block ID + UTF-16 offset. */
  /** `offset`: character at the reading top (text rows); `px`: pixels into an image or page row. */
  private class Anchor(val blockId: String, val offset: Int, val px: Int = 0)

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
      if (tv == null || layout == null) return Anchor(row.id, 0, y - child.top)
      val ly = y - child.top - tv.paddingTop
      return Anchor(row.id, if (ly > 0) layout.getLineStart(layout.getLineForVertical(ly)) else 0)
    }
    return fallback?.let { Anchor(it.id, 0) }
  }

  private fun restoreAnchor(anchor: Anchor) {
    val block = ReaderViewNative.nativeBlockIndex(snapshot, anchor.blockId)
    if (block < 0) return
    if (anchor.px > 0) {
      val row = rowOfBlock(block)
      val r = rows.getOrNull(row) as? Row.Block
      if (r != null && r.index == block) {
        // The image or page row is still there: the same pixel at the reading top.
        recycler.stopScroll()
        programmaticScroll = false
        pendingScroll = PendingScroll(row, 0, sampleAfter = false)
        layoutManager.scrollToPositionWithOffset(row, -anchor.px)
        return
      }
    }
    // Text rows, or a block now covered by another row (its text took the page's place).
    scrollToBlock(block, anchor.offset, sampleAfter = false)
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
    styleCache.evictAll()
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

  private val blockCount: Int get() = blockTable.size / BLOCK_STRIDE
  private val sectionCount: Int get() = sectionTable.size / 2

  private fun blockType(i: Int) = blockTable[i * BLOCK_STRIDE]

  private fun blockLevel(i: Int) = blockTable[i * BLOCK_STRIDE + 1]

  private fun blockSection(i: Int) = blockTable[i * BLOCK_STRIDE + 2]

  private fun blockFrame(i: Int) = blockTable[i * BLOCK_STRIDE + 3]

  private fun sectionFirstBlock(s: Int) = sectionTable[s * 2]

  private fun sectionBlockCount(s: Int) = sectionTable[s * 2 + 1]

  private fun appendInserts(kind: String, target: String, out: MutableList<Row>) {
    for (spec in inserts) {
      if (spec.kind == kind && spec.target == target && hostFor(spec.key) != null) out += Row.Insert(spec.key)
    }
  }

  private fun rebuildRows() {
    loadSnapshot()
    highlightsDirty = false
    val highlightChanges = resolveHighlights()
    markersDirty = false
    val markerChanges = resolveMarkers()
    recycler.setPadding(0, theme.marginVerticalPx, 0, theme.marginVerticalPx)
    val next = ArrayList<Row>(blockCount + inserts.size)
    if (snapshot != 0L) {
      // Rows per display mode; a row stands for the blocks it covers, and
      // inserts at covered blocks go before / after that row.
      val plan = ReaderViewNative.nativePlanRows(snapshot, pageDisplay)
      var k = 0
      while (k + 3 < plan.size) {
        val block = plan[k]
        val cf = plan[k + 1]
        val cl = plan[k + 2]
        val page = plan[k + 3] == 1
        k += 4
        val id = ReaderViewNative.nativeBlockId(snapshot, block) ?: continue
        for (i in cf..cl) ReaderViewNative.nativeBlockId(snapshot, i)?.let { appendInserts("beforeBlock", it, next) }
        next += Row.Block(id, block, cf, cl, page)
        for (i in cf..cl) ReaderViewNative.nativeBlockId(snapshot, i)?.let { appendInserts("afterBlock", it, next) }
        val s = blockSection(cl)
        if (cl == sectionFirstBlock(s) + sectionBlockCount(s) - 1) {
          ReaderViewNative.nativeSectionId(snapshot, s)?.let { appendInserts("sectionEnd", it, next) }
        }
      }
      // Empty sections still get their sectionEnd inserts.
      for (s in 0 until sectionCount) {
        if (sectionBlockCount(s) == 0) {
          ReaderViewNative.nativeSectionId(snapshot, s)?.let { appendInserts("sectionEnd", it, next) }
        }
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
    rowByBlock = IntArray(blockCount) { -1 }
    for ((pos, row) in next.withIndex()) {
      if (row is Row.Block) for (i in row.coverFirst..row.coverLast) rowByBlock[i] = pos
    }
    if (!themeChanged) {
      for (block in highlightChanges) {
        val row = rowByBlock.getOrElse(block) { -1 }
        if (row >= 0) adapter.notifyItemChanged(row, PAYLOAD_HIGHLIGHT)
      }
    }
    recycler.invalidate()
    if (markerChanges.isNotEmpty() || markerWindow.isNotEmpty()) updateMarkerWindow(force = true)

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
    // Reflow (theme, revision) may have moved the followed highlight.
    pendingFollowCheck = true
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

  /** Row that shows or covers [block]. */
  private fun rowOfBlock(block: Int): Int =
    rowByBlock.getOrElse(block) { -1 }.takeIf { it >= 0 }
      ?: rows.indexOfFirst { it is Row.Block && block >= it.coverFirst && block <= it.coverLast }

  private fun blockText(i: Int): String =
    textCache.get(i) ?: (ReaderViewNative.nativeBlockText(snapshot, i) ?: "").also { textCache.put(i, it) }

  private fun blockStyles(i: Int): IntArray =
    styleCache.get(i) ?: ReaderViewNative.nativeBlockStyles(snapshot, i).also { styleCache.put(i, it) }

  /** Block text with its inline styles and current highlights. */
  private fun styledBlock(i: Int, t: Theme): CharSequence =
    styled(blockText(i), blockStyles(i), blockType(i) == TYPE_HEADING, spansByBlock[i], t)

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
        if (p.followAfter) {
          // Far follow move: counts as follow (a jump if far), then place it at the anchor.
          sample(ReaderViewNative.PHASE_FOLLOW)
          sample(ReaderViewNative.PHASE_IDLE)
          follow(animated = false, force = true, place = followPlaceAfter)
          followPlaceAfter = false
        }
      }
      if (pendingLayoutSample) {
        pendingLayoutSample = false
        sample(ReaderViewNative.PHASE_LAYOUT)
      }
      if (pendingFollowCheck && pendingScroll == null) {
        pendingFollowCheck = false
        follow(animated = false, force = true)
      }
    }

  // ---- Visibility and events ----

  /**
   * Visible blocks (flat indices) as [readFirst, readLast, shownFirst, shownLast]
   * (-1 when none). Read: at least half of min(its height, the viewport) on
   * screen (reading progress). Shown: any part in the reading area, between the
   * vertical margins (the visible range; its first block holds the line at the
   * reading top, where scrollToLocator puts a line).
   */
  private fun visibleBlocks(insertKeys: MutableList<String>): IntArray? {
    val viewport = recycler.height
    if (viewport <= 0) return null
    val readTop = recycler.paddingTop
    val readBottom = viewport - recycler.paddingBottom
    val out = intArrayOf(-1, -1, -1, -1)
    fun merge(range: IntArray, at: Int) {
      if (range.size < 2) return
      if (out[at] < 0 || range[0] < out[at]) out[at] = range[0]
      if (range[1] > out[at + 1]) out[at + 1] = range[1]
    }
    for (c in 0 until recycler.childCount) {
      val child = recycler.getChildAt(c)
      val row = rows.getOrNull(recycler.getChildAdapterPosition(child)) ?: continue
      val shown = min(child.bottom, viewport) - max(child.top, 0)
      if (row is Row.Insert) {
        if (shown > 0) insertKeys += row.key
        continue
      }
      if (child.height <= 0 || shown <= 0) continue
      val r = row as Row.Block
      // Shared rules (blocks on a page image by their rectangle); covered
      // blocks count with their row.
      val read =
        ReaderViewNative.nativeRowVisibleBlocks(
          snapshot,
          r.index,
          r.coverFirst,
          r.coverLast,
          r.page,
          max(0, -child.top).toFloat(),
          min(child.height, viewport - child.top).toFloat(),
          child.height.toFloat(),
          viewport.toFloat(),
          false,
        )
      merge(read, 0)
      if (child.bottom > readTop && child.top < readBottom) {
        val inArea =
          ReaderViewNative.nativeRowVisibleBlocks(
            snapshot,
            r.index,
            r.coverFirst,
            r.coverLast,
            r.page,
            max(0, readTop - child.top).toFloat(),
            min(child.height, readBottom - child.top).toFloat(),
            child.height.toFloat(),
            viewport.toFloat(),
            true,
          )
        merge(inArea, 2)
      }
    }
    return if (out[0] >= 0 || out[2] >= 0) out else null
  }

  /** UTF-16 offset of the first visible character in the first visible block. */
  private fun firstVisibleOffset(block: Int): Int {
    val row = rowOfBlock(block)
    // Only the block's own text row has offsets (not a row that covers it).
    if ((rows.getOrNull(row) as? Row.Block)?.index != block) return 0
    val holder = recycler.findViewHolderForAdapterPosition(row) as? TextHolder ?: return 0
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
    val ev = ReaderViewNative.nativeTrackerSample(tracker, range[0], range[1], phase, range[2], range[3])
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
                3 -> "follow"
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
    // A marker view handles its own tap (onMarkerPress in JS).
    if (markerViewAt(e.x, e.y)) return
    val child = recycler.findChildViewUnder(e.x, e.y) ?: return
    val row = rows.getOrNull(recycler.getChildAdapterPosition(child)) as? Row.Block ?: return
    val tv = (recycler.getChildViewHolder(child) as? TextHolder)?.text
    val offset =
      if (tv != null && tv.layout != null && !row.page) {
        tv.getOffsetForPosition(e.x - child.left, e.y - child.top - child.translationY)
      } else {
        -1
      }
    ReaderEvents.dispatch(this, ReaderEvents.TAP) {
      putString("blockId", row.id)
      putInt("offset", offset)
    }
  }

  // ---- Commands ----

  /** Puts `block` (and the line holding `offset`) at the top; finishes after layout. */
  private fun scrollToBlock(block: Int, offset: Int, sampleAfter: Boolean) {
    val row = rowOfBlock(block)
    if (row < 0) return
    recycler.stopScroll()
    programmaticScroll = false
    val r = rows[row] as? Row.Block
    if (r != null && r.index != block) {
      // A covered block: its place on the page image, else the row's top.
      val px = ReaderViewNative.nativeBlockOffsetInRow(snapshot, r.index, r.page, block, rowHeightOf(r).toFloat())
      pendingScroll = PendingScroll(row, 0, sampleAfter)
      layoutManager.scrollToPositionWithOffset(row, -px.toInt())
      return
    }
    pendingScroll = PendingScroll(row, offset, sampleAfter)
    layoutManager.scrollToPositionWithOffset(row, 0)
  }

  /** Height of an image or page row (0 when unknown); text rows are measured by the layout. */
  private fun rowHeightOf(r: Row.Block): Int {
    val w = blockTable[r.index * BLOCK_STRIDE + 4]
    val h = blockTable[r.index * BLOCK_STRIDE + 5]
    if (w <= 0 || h <= 0) return 0
    val avail = if (recycler.width > 0) recycler.width else resources.displayMetrics.widthPixels
    return if (r.page) ceil(avail.toFloat() * h / w).toInt() else 0
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
    styleCache.evictAll()
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

  /**
   * Layer over the list that holds the mounted marker hosts. Each host is laid
   * out at the size Yoga computed, at (0, 0); [positionMarkers] moves it with
   * translations. Touches are not consumed here: they reach the list (scroll,
   * taps) while RN dispatches JS touches from the root view.
   */
  private class MarkerLayer(context: Context) : ViewGroup(context) {
    // See ReaderRecyclerView: a host must really leave when it is moved.
    override fun startViewTransition(view: View) = Unit

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
      for (i in 0 until childCount) {
        val h = getChildAt(i) as? SherpaReaderInsertView ?: continue
        h.measure(
          MeasureSpec.makeMeasureSpec(max(0, h.yogaWidth), MeasureSpec.EXACTLY),
          MeasureSpec.makeMeasureSpec(max(0, h.yogaHeight), MeasureSpec.EXACTLY),
        )
      }
      setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), MeasureSpec.getSize(heightMeasureSpec))
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
      for (i in 0 until childCount) {
        val h = getChildAt(i)
        h.layout(0, 0, h.measuredWidth, h.measuredHeight)
      }
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun dispatchTouchEvent(ev: MotionEvent): Boolean = false
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

  private class TextHolder(val text: ReaderTextView) : RecyclerView.ViewHolder(text)

  private class ImageHolder(
    root: FrameLayout,
    val frame: OfflineImageBufferFrameView,
    val overlay: PageHighlightOverlay,
  ) : RecyclerView.ViewHolder(root)

  /** A highlight drawn over a page image: a rect normalized to the page. */
  private data class PageMark(val x: Float, val y: Float, val w: Float, val h: Float, val style: Int, val color: Int)

  /**
   * Highlights over a page image (the page fills the view): background as a
   * translucent fill, underline as a line under the text, text color as a frame.
   */
  private class PageHighlightOverlay(context: Context) : View(context) {
    var marks: List<PageMark> = emptyList()
      set(value) {
        if (field != value) {
          field = value
          invalidate()
        }
      }
    private val fill = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
    private val stroke =
      android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
        style = android.graphics.Paint.Style.STROKE
        strokeWidth = PixelUtil.toPixelFromDIP(2f)
      }

    override fun onDraw(canvas: Canvas) {
      val w = width.toFloat()
      val h = height.toFloat()
      for (m in marks) {
        val l = m.x * w
        val t = m.y * h
        val r = (m.x + m.w) * w
        val b = (m.y + m.h) * h
        when (m.style) {
          1 -> {
            stroke.color = m.color
            canvas.drawLine(l, b, r, b, stroke)
          }
          2 -> {
            stroke.color = m.color
            canvas.drawRect(l, t, r, b, stroke)
          }
          else -> {
            fill.color = m.color
            canvas.drawRect(l, t, r, b, fill)
          }
        }
      }
    }
  }

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
            TYPE_IMAGE, TYPE_PAGE -> VIEW_IMAGE
            TYPE_SEPARATOR -> VIEW_SEPARATOR
            else -> VIEW_TEXT
          }
      }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
      val lp = RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
      return when (viewType) {
        VIEW_IMAGE -> {
          val frame =
            OfflineImageBufferFrameView(reactContext).apply {
              layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
              setResizeMode("contain")
              adjustViewBounds = false
            }
          val overlay =
            PageHighlightOverlay(parent.context).apply {
              layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            }
          val root =
            FrameLayout(parent.context).apply {
              layoutParams = lp
              addView(frame)
              addView(overlay)
            }
          ImageHolder(root, frame, overlay)
        }
        VIEW_SEPARATOR -> SeparatorHolder(SeparatorView(parent.context).apply { layoutParams = lp })
        VIEW_INSERT -> InsertHolder(InsertContainer(parent.context).apply { layoutParams = lp })
        else ->
          TextHolder(
            ReaderTextView(parent.context).apply {
              layoutParams = lp
              includeFontPadding = false
              customSelectionActionModeCallback = SelectionCallback(this)
            }
          )
      }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int, payloads: MutableList<Any>) {
      val r = rows.getOrNull(position)
      val partial = payloads.isNotEmpty() && payloads.all { it == PAYLOAD_HIGHLIGHT }
      if (partial && r is Row.Block && (holder is TextHolder || holder is ImageHolder)) {
        // Highlight change: same text, styles and fonts, so the row height stays.
        if (holder is TextHolder) holder.text.setTextKeepingSelection(styledBlock(r.index, theme))
        if (holder is ImageHolder) holder.overlay.marks = pageMarks(r, theme)
        return
      }
      onBindViewHolder(holder, position)
    }

    override fun onViewAttachedToWindow(holder: RecyclerView.ViewHolder) {
      // A selectable TextView that was detached loses its selection handles
      // ("TextView does not support text selection"); re-enabling fixes it.
      if (holder is TextHolder && holder.text.isTextSelectable) {
        holder.text.isEnabled = false
        holder.text.isEnabled = true
      }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
      val t = theme
      when (val r = rows[position]) {
        is Row.Insert -> bindInsert(holder as InsertHolder, r)
        is Row.Block ->
          when (holder) {
            is TextHolder -> bindText(holder, r.index, t)
            is ImageHolder -> {
              bindImage(holder, r.index, t, r.page)
              holder.overlay.marks = pageMarks(r, t)
            }
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
      tv.blockIndex = index
      tv.setSelectableText(selectable)
      tv.text = styledBlock(index, t)
      ViewCompat.setAccessibilityHeading(tv, level > 0)
    }

    private fun bindImage(holder: ImageHolder, index: Int, t: Theme, page: Boolean) {
      val v = holder.frame
      val root = holder.itemView
      val frame = blockFrame(index)
      val w = blockTable[index * BLOCK_STRIDE + 4]
      val h = blockTable[index * BLOCK_STRIDE + 5]
      val avail = if (recycler.width > 0) recycler.width else resources.displayMetrics.widthPixels
      val viewport = if (recycler.height > 0) recycler.height else resources.displayMetrics.heightPixels
      if (page) {
        // A page: full width, no margins, its own height (pages follow each other).
        root.layoutParams.height = if (frame >= 0 && w > 0 && h > 0) ceil(avail.toFloat() * h / w).toInt() else 0
        v.setPadding(0, 0, 0, 0)
      } else {
        val width = max(1, avail - 2 * t.marginHorizontalPx)
        val height = if (frame >= 0 && w > 0 && h > 0) min(width.toFloat() * h / w, viewport * 0.9f) else 0f
        root.layoutParams.height = if (height > 0) ceil(height + 1.5f * t.paragraphSpacingPx).toInt() else 0
        v.setPadding(t.marginHorizontalPx, t.paragraphSpacingPx / 2, t.marginHorizontalPx, t.paragraphSpacingPx)
      }
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
      if (holder is TextHolder) holder.text.clearSelection()
      if (holder is InsertHolder) {
        holder.container.removeAllViews()
        holder.container.host = null
      }
    }
  }

  /** Underline with its own color and thickness (API 29+; older versions use the text color). */
  /**
   * An inline italic / bold run: the family's face for [flags] (1 italic, 2 bold).
   * What the face still lacks is synthesized like StyleSpan does (fake bold,
   * skew), which keeps a family without italic or bold files readable.
   */
  private class ReaderFaceSpan(private val face: Typeface, private val flags: Int) : MetricAffectingSpan() {
    override fun updateDrawState(tp: TextPaint) = apply(tp)

    override fun updateMeasureState(tp: TextPaint) = apply(tp)

    private fun apply(tp: TextPaint) {
      tp.typeface = face
      val want = (if (flags and 1 != 0) Typeface.ITALIC else 0) or (if (flags and 2 != 0) Typeface.BOLD else 0)
      val fake = want and face.style.inv()
      if (fake and Typeface.BOLD != 0) tp.isFakeBoldText = true
      if (fake and Typeface.ITALIC != 0) tp.textSkewX = -0.25f
    }
  }

  private class UnderlineColorSpan(private val color: Int, private val thickness: Float) :
    CharacterStyle(), UpdateAppearance {
    override fun updateDrawState(tp: TextPaint) {
      tp.isUnderlineText = true
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        tp.underlineColor = color
        tp.underlineThickness = thickness
      }
    }
  }

  companion object {
    private const val PAYLOAD_HIGHLIGHT = "highlight"
    private const val MENU_ITEM_BASE = 0x5e00
    private val DEFAULT_ACCENT = Color.rgb(0, 122, 255)
    /** Ints per block in nativeBlockTable: type, level, section, frame, w, h, flags. */
    private const val BLOCK_STRIDE = 7
    private const val TYPE_HEADING = 1
    private const val TYPE_IMAGE = 2
    private const val TYPE_SEPARATOR = 3
    private const val TYPE_PAGE = 4

    private const val VIEW_TEXT = 0
    private const val VIEW_IMAGE = 1
    private const val VIEW_SEPARATOR = 2
    private const val VIEW_INSERT = 3

    private val HEADING_SCALE = floatArrayOf(1f, 1.6f, 1.35f, 1.2f, 1.1f, 1.05f, 1f)
  }
}
