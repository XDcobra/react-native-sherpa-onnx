package com.sherpaonnx.image

import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

@ReactModule(name = OfflineImageBufferFrameViewManager.REACT_CLASS)
class OfflineImageBufferFrameViewManager :
  SimpleViewManager<OfflineImageBufferFrameView>() {

  override fun getName(): String = REACT_CLASS

  override fun createViewInstance(reactContext: ThemedReactContext): OfflineImageBufferFrameView {
    return OfflineImageBufferFrameView(reactContext)
  }

  @ReactProp(name = "bufferId")
  fun setBufferId(view: OfflineImageBufferFrameView, bufferId: String?) {
    view.setBufferId(bufferId)
  }

  @ReactProp(name = "frameIndex", defaultInt = 0)
  fun setFrameIndex(view: OfflineImageBufferFrameView, frameIndex: Int) {
    view.setFrameIndex(frameIndex)
  }

  @ReactProp(name = "maxSide", defaultInt = 0)
  fun setMaxSide(view: OfflineImageBufferFrameView, maxSide: Int) {
    view.setMaxSide(maxSide)
  }

  @ReactProp(name = "resizeMode")
  fun setResizeMode(view: OfflineImageBufferFrameView, resizeMode: String?) {
    view.setResizeMode(resizeMode)
  }

  companion object {
    const val REACT_CLASS = "OfflineImageBufferFrameView"
  }
}
