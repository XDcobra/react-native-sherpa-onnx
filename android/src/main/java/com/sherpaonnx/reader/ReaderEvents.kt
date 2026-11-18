package com.sherpaonnx.reader

import android.view.View
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.events.Event

/** Direct event for SherpaReaderView (`top<Name>` → `on<Name>`). */
internal class ReaderEvent(
  surfaceId: Int,
  viewTag: Int,
  private val name: String,
  private val data: WritableMap,
) : Event<ReaderEvent>(surfaceId, viewTag) {
  override fun getEventName(): String = name

  override fun canCoalesce(): Boolean = false

  override fun getEventData(): WritableMap = data
}

internal object ReaderEvents {
  const val READY = "topReaderReady"
  const val VISIBLE_RANGE = "topVisibleRangeChange"
  const val FURTHEST = "topFurthestPositionChange"
  const val SECTION_END = "topSectionEnd"
  const val JUMP = "topJump"
  const val TAP = "topReaderTap"
  const val ERROR = "topReaderError"
  const val FOLLOW_CHANGE = "topFollowChange"
  const val SELECTION_ACTION = "topSelectionAction"
  const val MARKER_WINDOW = "topMarkerWindowChange"

  val ALL =
    listOf(READY, VISIBLE_RANGE, FURTHEST, SECTION_END, JUMP, TAP, ERROR, FOLLOW_CHANGE, SELECTION_ACTION, MARKER_WINDOW)

  fun dispatch(view: View, name: String, build: WritableMap.() -> Unit) {
    val context = view.context as? ReactContext ?: return
    val dispatcher = UIManagerHelper.getEventDispatcherForReactTag(context, view.id) ?: return
    val data = Arguments.createMap().apply(build)
    dispatcher.dispatchEvent(ReaderEvent(UIManagerHelper.getSurfaceId(view), view.id, name, data))
  }

  /** `topReaderReady` → `onReaderReady`. */
  fun registrationName(name: String): String = "on" + name.removePrefix("top")
}
