package com.sherpaonnx.reader

import android.view.View
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewGroupManager
import com.facebook.react.uimanager.ViewManagerDelegate
import com.facebook.react.viewmanagers.SherpaReaderViewManagerDelegate
import com.facebook.react.viewmanagers.SherpaReaderViewManagerInterface

/**
 * Fabric manager for [SherpaReaderView]. Children (insert hosts) are tracked in
 * a logical list and placed into list rows by the view, not added as subviews.
 */
@ReactModule(name = SherpaReaderViewManager.REACT_CLASS)
class SherpaReaderViewManager :
  ViewGroupManager<SherpaReaderView>(),
  SherpaReaderViewManagerInterface<SherpaReaderView> {
  private val delegate = SherpaReaderViewManagerDelegate(this)

  override fun getDelegate(): ViewManagerDelegate<SherpaReaderView> = delegate

  override fun getName(): String = REACT_CLASS

  override fun createViewInstance(context: ThemedReactContext): SherpaReaderView = SherpaReaderView(context)

  override fun getExportedCustomDirectEventTypeConstants(): MutableMap<String, Any> =
    ReaderEvents.ALL.associateWith { mapOf("registrationName" to ReaderEvents.registrationName(it)) }
      .toMutableMap()

  // ---- Logical children ----

  override fun needsCustomLayoutForChildren(): Boolean = true

  override fun addView(parent: SherpaReaderView, child: View, index: Int) {
    if (child is SherpaReaderInsertView) parent.addHost(child, index)
  }

  override fun getChildCount(parent: SherpaReaderView): Int = parent.hosts.size

  override fun getChildAt(parent: SherpaReaderView, index: Int): View? = parent.hosts.getOrNull(index)

  override fun removeViewAt(parent: SherpaReaderView, index: Int) = parent.removeHostAt(index)

  override fun removeView(parent: SherpaReaderView, view: View) {
    val index = parent.hosts.indexOf(view)
    if (index >= 0) parent.removeHostAt(index)
  }

  override fun removeAllViews(parent: SherpaReaderView) {
    while (parent.hosts.isNotEmpty()) parent.removeHostAt(parent.hosts.size - 1)
  }

  // ---- Props ----

  override fun setInserts(view: SherpaReaderView, value: ReadableArray?) = view.setInserts(value)

  override fun setDebugRowCount(view: SherpaReaderView, value: Int) = view.setDebugRowCount(value)

  override fun setDocumentId(view: SherpaReaderView, value: String?) = view.setDocumentId(value)

  override fun setDocumentRevision(view: SherpaReaderView, value: Int) = view.setDocumentRevision(value)

  // The block ID wins; the section ID is a fallback only for scrollToLocator.
  override fun setInitialSectionId(view: SherpaReaderView, value: String?) = Unit

  override fun setInitialBlockId(view: SherpaReaderView, value: String?) = view.setInitialBlockId(value)

  override fun setInitialOffset(view: SherpaReaderView, value: Int) = view.setInitialOffset(value)

  override fun setFurthestBlockId(view: SherpaReaderView, value: String?) = view.setFurthestBlockId(value)

  override fun setFurthestRevision(view: SherpaReaderView, value: Int) = view.setFurthestRevision(value)

  override fun setFontFamily(view: SherpaReaderView, value: String?) = view.setFontFamily(value)

  override fun setFontSize(view: SherpaReaderView, value: Float) = view.setFontSize(value)

  override fun setFontScale(view: SherpaReaderView, value: Float) = view.setFontScale(value)

  override fun setMaxFontScale(view: SherpaReaderView, value: Float) = view.setMaxFontScale(value)

  override fun setLineHeight(view: SherpaReaderView, value: Float) = view.setLineHeight(value)

  override fun setParagraphSpacing(view: SherpaReaderView, value: Float) = view.setParagraphSpacing(value)

  override fun setReaderMarginHorizontal(view: SherpaReaderView, value: Float) = view.setMarginHorizontal(value)

  override fun setReaderMarginVertical(view: SherpaReaderView, value: Float) = view.setMarginVertical(value)

  override fun setTextAlign(view: SherpaReaderView, value: String?) = view.setTextAlign(value)

  override fun setHyphenation(view: SherpaReaderView, value: Boolean) = view.setHyphenation(value)

  override fun setTextColor(view: SherpaReaderView, value: Int?) = view.setTextColor(value)

  override fun setAccentColor(view: SherpaReaderView, value: Int?) = view.setAccentColor(value)

  override fun setHighlights(view: SherpaReaderView, value: ReadableArray?) = view.setHighlights(value)

  override fun setFollowMode(view: SherpaReaderView, value: String?) = view.setFollowMode(value)

  override fun setFollowAnchor(view: SherpaReaderView, value: Float) = view.setFollowAnchor(value)

  override fun setFollowPauseOnUserScroll(view: SherpaReaderView, value: Boolean) =
    view.setFollowPauseOnUserScroll(value)

  override fun setJumpThreshold(view: SherpaReaderView, value: Int) = view.setJumpThreshold(value)

  override fun onAfterUpdateTransaction(view: SherpaReaderView) {
    super.onAfterUpdateTransaction(view)
    view.onPropsApplied()
  }

  override fun onDropViewInstance(view: SherpaReaderView) {
    view.dispose()
    super.onDropViewInstance(view)
  }

  // ---- Commands ----

  override fun receiveCommand(root: SherpaReaderView, commandId: String, args: ReadableArray?) {
    delegate.receiveCommand(root, commandId, args)
  }

  override fun scrollToLocator(
    view: SherpaReaderView,
    sectionId: String,
    blockId: String,
    offset: Int,
    animated: Boolean,
  ) = view.scrollToLocator(sectionId, blockId, offset, animated)

  override fun resumeFollow(view: SherpaReaderView) = view.resumeFollow()

  companion object {
    const val REACT_CLASS = "SherpaReaderView"
  }
}
