package com.sherpaonnx

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReactApplicationContext
import java.io.File
import java.io.FileOutputStream

internal class SherpaOnnxCoreHelper(
  private val context: ReactApplicationContext,
  private val logTag: String
) {
  fun resolveModelPath(config: ReadableMap, promise: Promise) {
    try {
      val type = config.getString("type") ?: "auto"
      val path = config.getString("path")
        ?: throw IllegalArgumentException("Path is required")

      val resolvedPath = when (type) {
        "asset" -> resolveAssetPath(path)
        "file" -> resolveFilePath(path)
        "auto" -> resolveAutoPath(path)
        else -> throw IllegalArgumentException("Unknown path type: $type")
      }

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
      promise.reject("LIST_ASSETS_ERROR", "Failed to list asset models: ${e.message}", e)
    }
  }

  private fun resolveAssetPath(assetPath: String): String {
    val assetManager = context.assets

    val pathParts = assetPath.split("/")
    val baseDir = if (pathParts.size > 1) pathParts[0] else "models"

    val targetBaseDir = File(context.filesDir, baseDir)
    targetBaseDir.mkdirs()

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
    val file = File(filePath)
    if (!file.exists()) {
      throw IllegalArgumentException("File path does not exist: $filePath")
    }
    if (!file.isDirectory) {
      throw IllegalArgumentException("Path is not a directory: $filePath")
    }
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
