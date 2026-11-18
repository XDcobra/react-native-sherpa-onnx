package com.sherpaonnx.reader

import android.content.Context
import android.view.View
import com.facebook.react.bridge.Arguments
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.uimanager.StateWrapper
import com.facebook.react.views.view.ReactViewGroup
import kotlin.math.abs

/**
 * Fabric host for one ReaderView insert or margin marker. Fabric measures it
 * with the size Yoga computed (inserts: full reader width; markers: their
 * content); [SherpaReaderView] moves it into a list row (inserts) or into its
 * marker layer next to the marker's line (markers) and lays it out there.
 */
class SherpaReaderInsertView(context: Context) : ReactViewGroup(context) {
  var insertKey: String = ""
    set(value) {
      if (field == value) return
      field = value
      reader?.onInsertKeyChanged(this)
    }

  /** Non-empty for a marker host. */
  var markerId: String = ""
    set(value) {
      if (field == value) return
      field = value
      reader?.onInsertKeyChanged(this)
    }

  var reader: SherpaReaderView? = null

  /** Fabric state of the host's shadow node (see SherpaReaderInsertState). */
  var stateWrapper: StateWrapper? = null

  private var lastOffsetX = Float.NaN
  private var lastOffsetY = Float.NaN

  /**
   * Where the host is shown, in px relative to the reader's top-left (its Yoga
   * origin). Pushed into the shadow state so `measure` matches the screen.
   */
  fun setOnScreenOrigin(xPx: Int, yPx: Int) {
    val wrapper = stateWrapper ?: return
    val x = PixelUtil.toDIPFromPixel(xPx.toFloat())
    val y = PixelUtil.toDIPFromPixel(yPx.toFloat())
    if (abs(x - lastOffsetX) < 0.5f && abs(y - lastOffsetY) < 0.5f) return
    lastOffsetX = x
    lastOffsetY = y
    wrapper.updateState(
      Arguments.createMap().apply {
        putDouble("x", x.toDouble())
        putDouble("y", y.toDouble())
      }
    )
  }

  /** Size from the latest Fabric (Yoga) measure; valid while off screen. */
  var yogaWidth: Int = 0
    private set
  var yogaHeight: Int = 0
    private set

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val w = View.MeasureSpec.getSize(widthMeasureSpec)
    val h = View.MeasureSpec.getSize(heightMeasureSpec)
    val fromYoga =
      View.MeasureSpec.getMode(widthMeasureSpec) == View.MeasureSpec.EXACTLY &&
        View.MeasureSpec.getMode(heightMeasureSpec) == View.MeasureSpec.EXACTLY
    super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    if (fromYoga && (w != yogaWidth || h != yogaHeight)) {
      // Insert rows depend on the height only; marker views on both.
      val resized = h != yogaHeight || (markerId.isNotEmpty() && w != yogaWidth)
      yogaWidth = w
      yogaHeight = h
      if (resized) {
        reader?.onInsertResized(this)
      }
    }
  }
}
