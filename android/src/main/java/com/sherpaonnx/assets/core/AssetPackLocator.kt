package com.sherpaonnx.assets.core

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.google.android.play.core.assetpacks.AssetPackLocation
import com.google.android.play.core.assetpacks.AssetPackManagerFactory
import com.google.android.play.core.assetpacks.model.AssetPackStorageMethod
import java.io.File

internal class AssetPackLocator(
  private val context: ReactApplicationContext,
  private val logTag: String,
) {
  fun getAssetPackPath(packName: String, promise: Promise) {
    try {
      Log.i(logTag, "getAssetPackPath: packName=$packName")
      val assetPackManager = AssetPackManagerFactory.getInstance(context)
      var location: AssetPackLocation? = assetPackManager.getPackLocation(packName)
      if (location == null) {
        val allLocations = assetPackManager.getPackLocations()
        location = allLocations?.get(packName)
        if (allLocations != null) {
          Log.i(logTag, "getAssetPackPath: getPackLocation was null, getPackLocations keys=${allLocations.keys}")
        }
        if (location == null) {
          Log.i(logTag, "getAssetPackPath: location is null for pack '$packName'")
          promise.resolve(null)
          return
        }
      }

      Log.i(
        logTag,
        "getAssetPackPath: storageMethod=${location.packStorageMethod()}, assetsPath=${location.assetsPath()}, path=${location.path()}",
      )

      if (location.packStorageMethod() != AssetPackStorageMethod.STORAGE_FILES) {
        Log.i(logTag, "getAssetPackPath: storage method is not STORAGE_FILES, returning null")
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

      Log.i(logTag, "getAssetPackPath: resolved modelsDir=$modelsDir")
      if (modelsDir != null) {
        val dir = File(modelsDir)
        Log.i(logTag, "getAssetPackPath: modelsDir exists=${dir.exists()}, isDir=${dir.isDirectory}")
        if (dir.exists() && dir.isDirectory) {
          val children = dir.listFiles()?.map { it.name } ?: emptyList()
          Log.i(logTag, "getAssetPackPath: modelsDir contents=$children")
        }
      }

      promise.resolve(modelsDir)
    } catch (e: Exception) {
      Log.w(logTag, "getAssetPackPath failed: ${e.message}")
      promise.resolve(null)
    }
  }

  fun listBundledArchiveAssetPaths(packName: String, promise: Promise) {
    try {
      val assetPackManager = AssetPackManagerFactory.getInstance(context)
      var location: AssetPackLocation? = assetPackManager.getPackLocation(packName)
      if (location == null) {
        location = assetPackManager.getPackLocations()?.get(packName)
      }
      if (location == null) {
        promise.resolve(Arguments.createArray())
        return
      }

      if (location.packStorageMethod() != AssetPackStorageMethod.STORAGE_FILES) {
        val assetPrefix = "models"
        val names = context.assets.list(assetPrefix) ?: emptyArray()
        val archives = names.filter { it.endsWith(".tar.zst") || it.endsWith(".tar.bz2") }
        val result = Arguments.createArray()
        for (name in archives) {
          result.pushString("$assetPrefix/$name")
        }
        Log.i(logTag, "listBundledArchiveAssetPaths: packName=$packName prefix=$assetPrefix count=${result.size()}")
        promise.resolve(result)
      } else {
        promise.resolve(Arguments.createArray())
      }
    } catch (e: Exception) {
      Log.w(logTag, "listBundledArchiveAssetPaths failed: ${e.message}")
      promise.resolve(Arguments.createArray())
    }
  }
}
