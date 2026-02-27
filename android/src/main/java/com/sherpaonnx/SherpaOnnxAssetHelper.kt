/**
 * SherpaOnnxAssetHelper.kt
 *
 * Purpose: Asset and model path logic for the SherpaOnnx module: resolveModelPath (asset/file/auto),
 * listAssetModels, listModelsAtPath, getAssetPackPath (PAD), and path/hint helpers. Aligns with
 * iOS SherpaOnnx+Assets.mm. Used by SherpaOnnxModule.
 */
package com.sherpaonnx

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReactApplicationContext
import com.google.android.play.core.assetpacks.AssetPackLocation
import com.google.android.play.core.assetpacks.AssetPackManagerFactory
import com.google.android.play.core.assetpacks.model.AssetPackStorageMethod
import java.io.File
import java.io.FileOutputStream

internal class SherpaOnnxAssetHelper(
  private val context: ReactApplicationContext,
  private val logTag: String
) {
  fun resolveModelPath(config: ReadableMap, promise: Promise) {
    try {
      val type = config.getString("type") ?: "auto"
      val path = config.getString("path")
        ?: throw IllegalArgumentException("Path is required")

      Log.i(logTag, "resolveModelPath: type=$type, path=$path")

      val resolvedPath = when (type) {
        "asset" -> resolveAssetPath(path)
        "file" -> resolveFilePath(path)
        "auto" -> resolveAutoPath(path)
        else -> throw IllegalArgumentException("Unknown path type: $type")
      }

      Log.i(logTag, "resolveModelPath: resolved=$resolvedPath")
      promise.resolve(resolvedPath)
    } catch (e: Exception) {
      val errorMessage = "Failed to resolve model path: ${e.message ?: e.javaClass.simpleName}"
      Log.e(logTag, errorMessage, e)
      promise.reject("PATH_RESOLVE_ERROR", errorMessage, e)
    }
  }

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
        modelMap.putString("hint", inferModelHint(folder))
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
      if (!baseDir.exists()) {
        throw IllegalArgumentException("Path does not exist: $path")
      }
      if (!baseDir.isDirectory) {
        throw IllegalArgumentException("Path is not a directory: $path")
      }

      val folders = mutableListOf<String>()

      if (recursive) {
        val basePath = baseDir.toPath()
        baseDir.walkTopDown().forEach { file ->
          if (file.isDirectory && file != baseDir) {
            val rel = basePath.relativize(file.toPath()).toString()
              .replace(File.separatorChar, '/')
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
        modelMap.putString("hint", inferModelHint(hintName))
        result.pushMap(modelMap)
      }

      promise.resolve(result)
    } catch (e: Exception) {
      Log.e(logTag, "LIST_MODELS_ERROR: Failed to list models at path: ${e.message}", e)
      promise.reject("LIST_MODELS_ERROR", "Failed to list models at path: ${e.message}", e)
    }
  }

  /**
   * Returns the filesystem path to the "models" directory inside a Play Asset Delivery (PAD) pack,
   * or null if the pack is not available.
   */
  fun getAssetPackPath(packName: String, promise: Promise) {
    try {
      Log.i(logTag, "getAssetPackPath: packName=$packName")
      val assetPackManager = AssetPackManagerFactory.getInstance(context)
      val location: AssetPackLocation? = assetPackManager.getPackLocation(packName)
      if (location == null) {
        Log.i(logTag, "getAssetPackPath: location is null for pack '$packName'")
        promise.resolve(null)
        return
      }
      Log.i(logTag, "getAssetPackPath: storageMethod=${location.packStorageMethod()}, " +
        "assetsPath=${location.assetsPath()}, path=${location.path()}")
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

  private fun resolveAssetPath(assetPath: String): String {
    Log.i(logTag, "resolveAssetPath: assetPath=$assetPath")
    val assetManager = context.assets

    val pathParts = assetPath.split("/")
    val baseDir = if (pathParts.size > 1) pathParts[0] else "models"

    val targetBaseDir = File(context.filesDir, baseDir)
    targetBaseDir.mkdirs()
    Log.i(logTag, "resolveAssetPath: targetBaseDir=${targetBaseDir.absolutePath}, exists=${targetBaseDir.exists()}")

    val isFilePath = pathParts.any { it.contains(".") && !it.startsWith(".") }

    val targetPath = if (isFilePath) {
      File(targetBaseDir, pathParts.drop(1).joinToString("/"))
    } else {
      File(targetBaseDir, File(assetPath).name)
    }

    if (isFilePath) {
      if (targetPath.exists() && targetPath.isFile) {
        return targetPath.absolutePath
      }
      val parentDir = targetPath.parentFile ?: targetBaseDir
      parentDir.mkdirs()

      try {
        assetManager.open(assetPath).use { input ->
          FileOutputStream(targetPath).use { output ->
            input.copyTo(output)
          }
        }
        return targetPath.absolutePath
      } catch (e: java.io.FileNotFoundException) {
        val parentAssetPath = pathParts.dropLast(1).joinToString("/")
        if (parentAssetPath.isNotEmpty()) {
          try {
            copyAssetRecursively(assetManager, parentAssetPath, parentDir)
            if (targetPath.exists() && targetPath.isFile) {
              return targetPath.absolutePath
            }
            throw IllegalArgumentException("File not found after copying parent directory: $assetPath")
          } catch (dirException: Exception) {
            throw IllegalArgumentException(
              "Failed to extract asset file: $assetPath. Tried direct copy and directory copy.",
              dirException
            )
          }
        } else {
          throw IllegalArgumentException("Failed to extract asset file: $assetPath", e)
        }
      } catch (e: Exception) {
        throw IllegalArgumentException("Failed to extract asset file: $assetPath", e)
      }
    } else {
      if (targetPath.exists() && targetPath.isDirectory) {
        return targetPath.absolutePath
      }
      try {
        targetPath.mkdirs()
        copyAssetRecursively(assetManager, assetPath, targetPath)
        return targetPath.absolutePath
      } catch (e: Exception) {
        throw IllegalArgumentException("Failed to extract asset directory: $assetPath", e)
      }
    }
  }

  private fun copyAssetRecursively(
    assetManager: android.content.res.AssetManager,
    assetPath: String,
    targetDir: File
  ) {
    val assetFiles = assetManager.list(assetPath)
      ?: throw IllegalArgumentException("Asset path not found: $assetPath")

    for (fileName in assetFiles) {
      val assetFilePath = "$assetPath/$fileName"
      val targetFile = File(targetDir, fileName)

      try {
        val subFiles = assetManager.list(assetFilePath)
        if (subFiles != null && subFiles.isNotEmpty()) {
          targetFile.mkdirs()
          copyAssetRecursively(assetManager, assetFilePath, targetFile)
        } else {
          assetManager.open(assetFilePath).use { input ->
            FileOutputStream(targetFile).use { output ->
              input.copyTo(output)
            }
          }
        }
      } catch (e: Exception) {
        try {
          assetManager.open(assetFilePath).use { input ->
            FileOutputStream(targetFile).use { output ->
              input.copyTo(output)
            }
          }
        } catch (fileException: Exception) {
          throw IllegalArgumentException("Failed to copy asset: $assetFilePath", fileException)
        }
      }
    }
  }

  private fun resolveFilePath(filePath: String): String {
    Log.i(logTag, "resolveFilePath: filePath=$filePath")
    val file = File(filePath)
    if (!file.exists()) {
      Log.e(logTag, "resolveFilePath: path does not exist: $filePath")
      throw IllegalArgumentException("File path does not exist: $filePath")
    }
    if (!file.isDirectory) {
      Log.e(logTag, "resolveFilePath: path is not a directory: $filePath")
      throw IllegalArgumentException("Path is not a directory: $filePath")
    }
    val children = file.listFiles()?.map { it.name } ?: emptyList()
    Log.i(logTag, "resolveFilePath: resolved=${file.absolutePath}, contents=$children")
    return file.absolutePath
  }

  private fun resolveAutoPath(path: String): String {
    return try {
      resolveAssetPath(path)
    } catch (e: Exception) {
      try {
        resolveFilePath(path)
      } catch (fileException: Exception) {
        throw IllegalArgumentException(
          "Path not found as asset or file: $path. Asset error: ${e.message}, File error: ${fileException.message}",
          e
        )
      }
    }
  }

  private fun inferModelHint(folderName: String): String {
    val name = folderName.lowercase()
    val sttHints = listOf(
      "zipformer",
      "paraformer",
      "nemo",
      "parakeet",
      "whisper",
      "wenet",
      "sensevoice",
      "sense-voice",
      "sense",
      "funasr",
      "transducer",
      "ctc",
      "asr"
    )
    val ttsHints = listOf(
      "vits",
      "piper",
      "matcha",
      "kokoro",
      "kitten",
      "pocket",
      "zipvoice",
      "melo",
      "coqui",
      "mms",
      "tts"
    )

    val isStt = sttHints.any { name.contains(it) }
    val isTts = ttsHints.any { name.contains(it) }

    return when {
      isStt && !isTts -> "stt"
      isTts && !isStt -> "tts"
      else -> "unknown"
    }
  }
}
