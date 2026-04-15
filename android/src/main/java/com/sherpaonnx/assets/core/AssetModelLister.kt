package com.sherpaonnx.assets.core

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import java.io.File

internal class AssetModelLister(
  private val context: ReactApplicationContext,
  private val logTag: String,
) {
  fun listAssetModels(promise: Promise) {
    try {
      val assetManager = context.assets
      val modelFolders = mutableListOf<String>()

      try {
        val items = assetManager.list("models") ?: emptyArray()
        for (item in items) {
          val subItems = assetManager.list("models/$item")
          if (subItems != null && subItems.isNotEmpty()) {
            modelFolders.add(item)
          }
        }
      } catch (e: Exception) {
        Log.w(logTag, "Could not list models directory: ${e.message}")
      }

      val result = Arguments.createArray()
      modelFolders.forEach { folder ->
        val modelMap = Arguments.createMap()
        modelMap.putString("folder", folder)
        modelMap.putString("hint", AssetHintInferer.inferModelHint(folder))
        result.pushMap(modelMap)
      }

      promise.resolve(result)
    } catch (e: Exception) {
      Log.e(logTag, "LIST_ASSETS_ERROR: Failed to list asset models: ${e.message}", e)
      promise.reject("LIST_ASSETS_ERROR", "Failed to list asset models: ${e.message}", e)
    }
  }

  fun listModelsAtPath(path: String, recursive: Boolean, promise: Promise) {
    try {
      val baseDir = File(path)
      if (!baseDir.exists() || !baseDir.isDirectory) {
        promise.resolve(Arguments.createArray())
        return
      }

      val folders = mutableListOf<String>()

      if (recursive) {
        val basePath = baseDir.toPath()
        baseDir.walkTopDown().forEach { file ->
          if (file.isDirectory && file != baseDir) {
            val rel = basePath.relativize(file.toPath()).toString().replace(File.separatorChar, '/')
            if (rel.isNotEmpty()) {
              folders.add(rel)
            }
          }
        }
      } else {
        val children = baseDir.listFiles() ?: emptyArray()
        for (child in children) {
          if (child.isDirectory) {
            folders.add(child.name)
          }
        }
      }

      val result = Arguments.createArray()
      folders.distinct().forEach { folder ->
        val hintName = folder.substringAfterLast('/')
        val modelMap = Arguments.createMap()
        modelMap.putString("folder", folder)
        modelMap.putString("hint", AssetHintInferer.inferModelHint(hintName))
        result.pushMap(modelMap)
      }

      promise.resolve(result)
    } catch (e: Exception) {
      Log.e(logTag, "LIST_MODELS_ERROR: Failed to list models at path: ${e.message}", e)
      promise.reject("LIST_MODELS_ERROR", "Failed to list models at path: ${e.message}", e)
    }
  }
}
