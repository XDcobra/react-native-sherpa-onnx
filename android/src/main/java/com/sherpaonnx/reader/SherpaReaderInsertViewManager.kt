package com.sherpaonnx.reader

import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.ReactStylesDiffMap
import com.facebook.react.uimanager.StateWrapper
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.views.view.ReactViewGroup
import com.facebook.react.views.view.ReactViewManager

/** Insert host: a regular React view group plus the `insertKey` prop. */
@ReactModule(name = SherpaReaderInsertViewManager.REACT_CLASS)
class SherpaReaderInsertViewManager : ReactViewManager() {
  override fun getName(): String = REACT_CLASS

  override fun createViewInstance(context: ThemedReactContext): ReactViewGroup =
    SherpaReaderInsertView(context)

  override fun updateState(
    view: ReactViewGroup,
    props: ReactStylesDiffMap?,
    stateWrapper: StateWrapper?,
  ): Any? {
    (view as? SherpaReaderInsertView)?.stateWrapper = stateWrapper
    return null
  }

  @ReactProp(name = "insertKey")
  fun setInsertKey(view: ReactViewGroup, value: String?) {
    (view as? SherpaReaderInsertView)?.insertKey = value ?: ""
  }

  companion object {
    const val REACT_CLASS = "SherpaReaderInsertView"
  }
}
