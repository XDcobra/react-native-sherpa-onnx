package com.sherpaonnx.assets.core

import android.content.res.AssetManager
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReactApplicationContext
import java.io.File
import java.io.FileOutputStream

internal class AssetPathResolver(
  private val context: ReactApplicationContext,
  private val logTag: String,
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

  fun resolveAssetPath(assetPath: String): String {
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
              dirException,
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

  fun resolveFilePath(filePath: String): String {
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

  fun resolveAutoPath(path: String): String {
    return try {
      resolveAssetPath(path)
    } catch (assetException: Exception) {
      try {
        resolveFilePath(path)
      } catch (fileException: Exception) {
        throw IllegalArgumentException(
          "Path not found as asset or file: $path. Asset error: ${assetException.message}, File error: ${fileException.message}",
          assetException,
        )
      }
    }
  }

  private fun copyAssetRecursively(
    assetManager: AssetManager,
    assetPath: String,
    targetDir: File,
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
      } catch (_: Exception) {
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
}
