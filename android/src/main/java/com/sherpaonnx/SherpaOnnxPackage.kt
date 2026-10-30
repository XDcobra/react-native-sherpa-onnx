package com.sherpaonnx

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.ModuleSpec
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.sherpaonnx.image.OfflineImageBufferFrameViewManager
import com.sherpaonnx.video.preview.VideoPreviewTextureViewManager
import com.sherpaonnx.video.preview.VideoPreviewViewManager
import java.util.HashMap
import javax.inject.Provider

class SherpaOnnxPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
    return if (name == SherpaOnnxModule.NAME) {
      SherpaOnnxModule(reactContext)
    } else {
      null
    }
  }

  override fun getViewManagers(reactContext: ReactApplicationContext): List<ModuleSpec> {
    return listOf(
      ModuleSpec.viewManagerSpec(
        Provider { OfflineImageBufferFrameViewManager() }
      ),
      ModuleSpec.viewManagerSpec(
        Provider { VideoPreviewViewManager() }
      ),
      ModuleSpec.viewManagerSpec(
        Provider { VideoPreviewTextureViewManager() }
      ),
    )
  }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
    return ReactModuleInfoProvider {
      val moduleInfos: MutableMap<String, ReactModuleInfo> = HashMap()
      moduleInfos[SherpaOnnxModule.NAME] = ReactModuleInfo(
        SherpaOnnxModule.NAME,
        SherpaOnnxModule.NAME,
        false,  // canOverrideExistingModule
        false,  // needsEagerInit
        false,  // isCxxModule
        true // isTurboModule
      )
      moduleInfos
    }
  }
}
