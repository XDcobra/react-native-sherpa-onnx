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

  override fun setDocumentId(view: SherpaReaderView, value: String?) = Unit

  override fun setDocumentRevision(view: SherpaReaderView, value: Int) = Unit

  override fun setInitialSectionId(view: SherpaReaderView, value: String?) = Unit

  override fun setInitialBlockId(view: SherpaReaderView, value: String?) = Unit

  override fun setInitialOffset(view: SherpaReaderView, value: Int) = Unit

  override fun setFurthestBlockId(view: SherpaReaderView, value: String?) = Unit

  override fun setFurthestRevision(view: SherpaReaderView, value: Int) = Unit

  override fun setFontFamily(view: SherpaReaderView, value: String?) = Unit

  override fun setFontSize(view: SherpaReaderView, value: Float) = Unit

  override fun setFontScale(view: SherpaReaderView, value: Float) = Unit

  override fun setMaxFontScale(view: SherpaReaderView, value: Float) = Unit

  override fun setLineHeight(view: SherpaReaderView, value: Float) = Unit

  override fun setParagraphSpacing(view: SherpaReaderView, value: Float) = Unit

  override fun setMarginHorizontal(view: SherpaReaderView, value: Float) = Unit

  override fun setMarginVertical(view: SherpaReaderView, value: Float) = Unit

  override fun setTextAlign(view: SherpaReaderView, value: String?) = Unit

  override fun setHyphenation(view: SherpaReaderView, value: Boolean) = Unit

  override fun setTextColor(view: SherpaReaderView, value: Int?) = Unit

  override fun setAccentColor(view: SherpaReaderView, value: Int?) = Unit

  override fun setJumpThreshold(view: SherpaReaderView, value: Int) = Unit

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

  companion object {
    const val REACT_CLASS = "SherpaReaderView"
  }
}
