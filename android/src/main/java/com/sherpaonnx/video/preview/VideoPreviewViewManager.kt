package com.sherpaonnx.video.preview

import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

@ReactModule(name = VideoPreviewViewManager.REACT_CLASS)
class VideoPreviewViewManager : SimpleViewManager<VideoPreviewView>() {
  override fun getName(): String = REACT_CLASS

  override fun createViewInstance(reactContext: ThemedReactContext): VideoPreviewView {
    VideoPreviewService.ensure(reactContext)
    return VideoPreviewView(reactContext, useTexture = false)
  }

  @ReactProp(name = "playerId")
  fun setPlayerId(view: VideoPreviewView, playerId: String?) {
    view.setPlayerId(playerId)
  }

  @ReactProp(name = "resizeMode")
  fun setResizeMode(view: VideoPreviewView, resizeMode: String?) {
    view.setResizeMode(resizeMode)
  }

  companion object {
    const val REACT_CLASS = "SherpaOnnxVideoPreviewView"
  }
}
