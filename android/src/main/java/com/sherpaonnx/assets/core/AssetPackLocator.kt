package com.sherpaonnx.assets.core

import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.google.android.play.core.assetpacks.AssetPackManagerFactory
import com.google.android.play.core.assetpacks.model.AssetPackStorageMethod
import java.io.File

/** Resolves the PAD pack `…/models` directory (STORAGE_FILES only; content not inspected). */
internal class AssetPackLocator(
  private val context: ReactApplicationContext,
  private val logTag: String,
) {
  fun getAssetPackPath(packName: String, promise: Promise) {
    try {
      val assetPackManager = AssetPackManagerFactory.getInstance(context)
      var location = assetPackManager.getPackLocation(packName)
      if (location == null) {
        location = assetPackManager.getPackLocations()?.get(packName)
        if (location == null) {
          promise.resolve(null)
          return
        }
      }

      if (location.packStorageMethod() != AssetPackStorageMethod.STORAGE_FILES) {
        promise.resolve(null)
        return
      }

      val assetsPath = location.assetsPath()
      val path = location.path()
      val modelsDir = when {
        assetsPath != null && assetsPath.isNotEmpty() -> File(assetsPath, "models").absolutePath
        path != null && path.isNotEmpty() -> File(path, "assets/models").absolutePath
        else -> null
      }

      promise.resolve(modelsDir)
    } catch (e: Exception) {
      Log.w(logTag, "getAssetPackPath failed: ${e.message}")
      promise.resolve(null)
    }
  }
}
