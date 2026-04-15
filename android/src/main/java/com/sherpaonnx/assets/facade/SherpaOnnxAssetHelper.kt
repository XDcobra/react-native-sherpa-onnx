package com.sherpaonnx.assets.facade

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReactApplicationContext
import com.sherpaonnx.assets.core.AssetModelLister
import com.sherpaonnx.assets.core.AssetPackLocator
import com.sherpaonnx.assets.core.AssetPathResolver

internal class SherpaOnnxAssetHelper(
  context: ReactApplicationContext,
  logTag: String,
) {
  private val pathResolver = AssetPathResolver(context, logTag)
  private val modelLister = AssetModelLister(context, logTag)
  private val assetPackLocator = AssetPackLocator(context, logTag)

  fun resolveModelPath(config: ReadableMap, promise: Promise) {
    pathResolver.resolveModelPath(config, promise)
  }

  fun listAssetModels(promise: Promise) {
    modelLister.listAssetModels(promise)
  }

  fun listModelsAtPath(path: String, recursive: Boolean, promise: Promise) {
    modelLister.listModelsAtPath(path, recursive, promise)
  }

  fun getAssetPackPath(packName: String, promise: Promise) {
    assetPackLocator.getAssetPackPath(packName, promise)
  }

  fun listBundledArchiveAssetPaths(packName: String, promise: Promise) {
    assetPackLocator.listBundledArchiveAssetPaths(packName, promise)
  }
}
