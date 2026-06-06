package com.sherpaonnx.extraction

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext

/**
 * Lists immediate asset paths under an APK asset prefix (e.g. `models/foo.bin`).
 * Used by the extraction layer for install-time ship content merged into the app APK.
 * Not tied to Play Asset Delivery pack names.
 */
internal class ApkAssetPathLister(
  private val context: ReactApplicationContext,
  private val logTag: String,
) {
  fun listApkAssetPaths(assetPrefix: String, promise: Promise) {
    try {
      val prefix = assetPrefix.trim().trimEnd('/')
      if (prefix.isEmpty()) {
        promise.resolve(Arguments.createArray())
        return
      }
      val result = Arguments.createArray()
      val names = context.assets.list(prefix) ?: emptyArray()
      for (name in names) {
        if (name.isEmpty() || name.contains('/')) {
          continue
        }
        result.pushString("$prefix/$name")
      }
      promise.resolve(result)
    } catch (e: Exception) {
      Log.w(logTag, "listApkAssetPaths failed: ${e.message}")
      promise.resolve(Arguments.createArray())
    }
  }
}
