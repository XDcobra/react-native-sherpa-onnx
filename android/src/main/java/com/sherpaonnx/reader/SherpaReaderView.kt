package com.sherpaonnx.reader

import android.annotation.SuppressLint
import android.content.Context
import android.util.TypedValue
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.uimanager.events.NativeGestureUtil

/**
 * Fabric ReaderView: a RecyclerView of reader blocks. React children are insert
 * hosts ([SherpaReaderInsertView]); they are kept in a logical child list (see
 * [SherpaReaderViewManager]) and moved into the rows that `inserts` assigns.
 */
@SuppressLint("ViewConstructor")
class SherpaReaderView(context: Context) : FrameLayout(context) {
  internal data class InsertSpec(val key: String, val kind: String, val target: String)

  private sealed class Row {
    data class Block(val index: Int) : Row()
    data class Insert(val key: String) : Row()
  }

  /** Logical React children, in Fabric's order. Not attached to this view. */
  internal val hosts = mutableListOf<SherpaReaderInsertView>()

  private val recycler = ReaderRecyclerView(context)
  private val layoutManager = LinearLayoutManager(context)
  private val adapter = Adapter()
  private var rows: List<Row> = emptyList()
  private var inserts: List<InsertSpec> = emptyList()
  private var debugRowCount = 0
  private var rebuildPosted = false
  private var readySent = false
  private var lastFirst = -1
  private var lastLast = -1

  init {
    recycler.layoutManager = layoutManager
    recycler.adapter = adapter
    recycler.itemAnimator = null
    recycler.clipToPadding = false
    addView(recycler, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    recycler.addOnScrollListener(
      object : RecyclerView.OnScrollListener() {
        override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) {
          emitVisibleRange(false)
          // Throttled: Pressability measures on touch-down; at rest the sync is exact.
          if (android.os.SystemClock.uptimeMillis() - lastOriginSync > 50) syncInsertOrigins()
        }

        override fun onScrollStateChanged(rv: RecyclerView, newState: Int) {
          if (newState == RecyclerView.SCROLL_STATE_IDLE) {
            syncInsertOrigins()
            emitVisibleRange(true)
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
        context,
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

  // ---- Props ----

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

  internal fun setDebugRowCount(value: Int) {
    if (value != debugRowCount) {
      debugRowCount = value
      scheduleRebuild()
    }
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

  private var lastOriginSync = 0L

  /** Pushes every attached insert host's position (reader coordinates) into its shadow state. */
  private fun syncInsertOrigins() {
    lastOriginSync = android.os.SystemClock.uptimeMillis()
    val loc = IntArray(2)
    val own = IntArray(2)
    getLocationInWindow(own)
    for (host in hosts) {
      if (host.parent !is InsertContainer || !host.isAttachedToWindow) continue
      host.getLocationInWindow(loc)
      host.setOnScreenOrigin(loc[0] - own[0], loc[1] - own[1])
    }
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    super.onLayout(changed, left, top, right, bottom)
    post(syncOrigins)
  }

  private val syncOrigins = Runnable { if (isAttachedToWindow) syncInsertOrigins() }

  internal fun onInsertResized(host: SherpaReaderInsertView) {
    val pos = rows.indexOfFirst { it is Row.Insert && it.key == host.insertKey }
    if (pos >= 0) {
      post { if (isAttachedToWindow && pos < rows.size) adapter.notifyItemChanged(pos) }
    }
  }

  private fun hostFor(key: String): SherpaReaderInsertView? = hosts.firstOrNull { it.insertKey == key }

  // ---- Rows ----

  private fun scheduleRebuild() {
    // Fabric applies props, child mounts and layout in one batch; rebuild once after it.
    if (rebuildPosted) return
    rebuildPosted = true
    post {
      rebuildPosted = false
      rebuildRows()
    }
    // rebuildRows runs even while detached (state is kept); the RecyclerView
    // only lays out again once attached.
  }

  private fun appendInserts(kind: String, target: String, out: MutableList<Row>) {
    for (spec in inserts) {
      if (spec.kind == kind && spec.target == target && hostFor(spec.key) != null) {
        out += Row.Insert(spec.key)
      }
    }
  }

  private fun rebuildRows() {
    val next = ArrayList<Row>(debugRowCount + inserts.size)
    for (i in 0 until debugRowCount) {
      val blockId = debugBlockId(i)
      appendInserts("beforeBlock", blockId, next)
      next += Row.Block(i)
      appendInserts("afterBlock", blockId, next)
      val lastInSection = (i + 1) % BLOCKS_PER_SECTION == 0 || i + 1 == debugRowCount
      if (lastInSection) appendInserts("sectionEnd", debugSectionId(i), next)
    }
    val old = rows
    rows = next
    // Targeted updates (not notifyDataSetChanged): holders stay valid, the first
    // visible row stays in place, and an unmount in the middle of a screen
    // transition does not invalidate every holder before a forced layout.
    DiffUtil.calculateDiff(
      object : DiffUtil.Callback() {
        override fun getOldListSize() = old.size

        override fun getNewListSize() = next.size

        override fun areItemsTheSame(o: Int, n: Int) = old[o] == next[n]

        override fun areContentsTheSame(o: Int, n: Int) = old[o] == next[n]
      },
      false,
    ).dispatchUpdatesTo(adapter)
    if (!readySent && debugRowCount > 0) {
      readySent = true
      ReaderEvents.dispatch(this, ReaderEvents.READY) {
        putInt("blockCount", debugRowCount)
        putInt("sectionCount", (debugRowCount + BLOCKS_PER_SECTION - 1) / BLOCKS_PER_SECTION)
      }
    }
  }

  // ---- Events ----

  private fun emitVisibleRange(settled: Boolean) {
    val firstPos = layoutManager.findFirstVisibleItemPosition()
    val lastPos = layoutManager.findLastVisibleItemPosition()
    if (firstPos < 0 || lastPos < 0) return
    var first = -1
    var last = -1
    val keys = Arguments.createArray()
    for (p in firstPos..lastPos.coerceAtMost(rows.size - 1)) {
      when (val r = rows[p]) {
        is Row.Block -> {
          if (first < 0) first = r.index
          last = r.index
        }
        is Row.Insert -> keys.pushString(r.key)
      }
    }
    if (first < 0) return
    if (!settled && first == lastFirst && last == lastLast) return
    lastFirst = first
    lastLast = last
    ReaderEvents.dispatch(this, ReaderEvents.VISIBLE_RANGE) {
      putString("firstSectionId", debugSectionId(first))
      putString("firstBlockId", debugBlockId(first))
      putString("lastSectionId", debugSectionId(last))
      putString("lastBlockId", debugBlockId(last))
      putInt("firstOffset", 0)
      putBoolean("settled", settled)
      putArray("visibleInsertKeys", keys)
    }
  }

  private fun handleTap(e: MotionEvent) {
    val child = recycler.findChildViewUnder(e.x, e.y) ?: return
    val pos = recycler.getChildAdapterPosition(child)
    val row = rows.getOrNull(pos) as? Row.Block ?: return
    ReaderEvents.dispatch(this, ReaderEvents.TAP) { putString("blockId", debugBlockId(row.index)) }
  }

  // ---- Commands ----

  internal fun scrollToLocator(sectionId: String, blockId: String, offset: Int, animated: Boolean) {
    val pos = rows.indexOfFirst { it is Row.Block && debugBlockId(it.index) == blockId }
    if (pos < 0) return
    if (animated) {
      recycler.smoothScrollToPosition(pos)
    } else {
      layoutManager.scrollToPositionWithOffset(pos, 0)
      post { emitVisibleRange(true) }
    }
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

    // react-native-screens calls startViewTransition on every descendant while a
    // screen is popped. A RecyclerView must be able to remove its own rows
    // (otherwise they stay "disappearing", keep their parent, and recycling
    // throws), so rows never take part in such a transition.
    override fun startViewTransition(view: View) = Unit

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

  private class BlockHolder(val text: TextView) : RecyclerView.ViewHolder(text)

  private class InsertHolder(val container: InsertContainer) : RecyclerView.ViewHolder(container)

  private inner class Adapter : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
    init {
      setHasStableIds(true)
    }

    override fun getItemCount(): Int = rows.size

    override fun getItemId(position: Int): Long =
      when (val r = rows[position]) {
        is Row.Block -> r.index.toLong()
        is Row.Insert -> (1L shl 40) + (r.key.hashCode().toLong() and 0xffffffffL)
      }

    override fun getItemViewType(position: Int): Int = if (rows[position] is Row.Block) 0 else 1

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
      val lp = RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
      return if (viewType == 0) {
        val tv = TextView(parent.context)
        val pad = (16 * parent.resources.displayMetrics.density).toInt()
        tv.setPadding(pad, pad / 2, pad, pad / 2)
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
        tv.layoutParams = lp
        BlockHolder(tv)
      } else {
        val c = InsertContainer(parent.context)
        c.layoutParams = lp
        InsertHolder(c)
      }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
      when (val r = rows[position]) {
        is Row.Block -> {
          val sb = StringBuilder(debugBlockId(r.index)).append(" — ")
          repeat(r.index % 4 + 1) { sb.append("The quick brown fox jumps over the lazy dog. ") }
          (holder as BlockHolder).text.text = sb
        }
        is Row.Insert -> {
          val container = (holder as InsertHolder).container
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
      }
    }

    override fun onViewRecycled(holder: RecyclerView.ViewHolder) {
      if (holder is InsertHolder) {
        holder.container.removeAllViews()
        holder.container.host = null
      }
    }
  }

  companion object {
    private const val BLOCKS_PER_SECTION = 10

    private fun debugSectionId(blockIndex: Int) = "s${blockIndex / BLOCKS_PER_SECTION}"

    private fun debugBlockId(blockIndex: Int) =
      "${debugSectionId(blockIndex)}.b${blockIndex % BLOCKS_PER_SECTION}"
  }
}
