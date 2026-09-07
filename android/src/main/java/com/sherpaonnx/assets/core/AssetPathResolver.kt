package com.sherpaonnx.assets.core

import android.content.res.AssetManager
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import java.io.File
import java.io.FileOutputStream

internal class AssetPathResolver(
  private val context: ReactApplicationContext,
  private val logTag: String,
) {
  fun resolveBundledAssetPath(relativePath: String, promise: Promise) {
    try {
      val path = relativePath.trim()
      if (path.isEmpty()) {
        throw IllegalArgumentException("Relative path is required")
      }

      Log.i(logTag, "resolveBundledAssetPath: relativePath=$path")

      val resolvedPath = resolveAssetPath(path)

      Log.i(logTag, "resolveBundledAssetPath: resolved=$resolvedPath")
      promise.resolve(resolvedPath)
    } catch (e: Exception) {
      val errorMessage =
        "Failed to resolve bundled asset path: ${e.message ?: e.javaClass.simpleName}"
      Log.e(logTag, errorMessage, e)
      promise.reject("PATH_RESOLVE_ERROR", errorMessage, e)
    }
  }

  fun resolveAssetPath(assetPath: String): String {
    Log.i(logTag, "resolveAssetPath: assetPath=$assetPath")
    val assetManager = context.assets

    val pathParts = assetPath.split("/").filter { it.isNotEmpty() }
    val baseDir = if (pathParts.size > 1) pathParts[0] else "models"

    val targetBaseDir = File(context.filesDir, baseDir)
    targetBaseDir.mkdirs()
    Log.i(
      logTag,
      "resolveAssetPath: targetBaseDir=${targetBaseDir.absolutePath}, exists=${targetBaseDir.exists()}",
    )

    val targetPath = if (pathParts.size > 1) {
      File(context.filesDir, pathParts.joinToString("/"))
    } else {
      File(targetBaseDir, pathParts[0])
    }

    // Determine whether assetPath is a directory or a file in APK assets.
    // In Android AssetManager, list() returns non-empty array for directories containing entries.
    // For single files, list() returns an empty array or null.
    val subItems = try {
      assetManager.list(assetPath)
    } catch (_: Exception) {
      null
    }
    val isDirectory = subItems != null && subItems.isNotEmpty()

    Log.i(logTag, "resolveAssetPath: isDirectory=$isDirectory, targetPath=${targetPath.absolutePath}")

    if (isDirectory) {
      if (targetPath.exists() && targetPath.isDirectory && (targetPath.list()?.isNotEmpty() == true)) {
        Log.i(logTag, "resolveAssetPath: directory already extracted at ${targetPath.absolutePath}")
        return targetPath.absolutePath
      }
      try {
        targetPath.mkdirs()
        copyAssetRecursively(assetManager, assetPath, targetPath)
        Log.i(logTag, "resolveAssetPath: extracted directory to ${targetPath.absolutePath}")
        return targetPath.absolutePath
      } catch (e: Exception) {
        throw IllegalArgumentException("Failed to extract asset directory: $assetPath", e)
      }
    } else {
      if (targetPath.exists() && targetPath.isFile && targetPath.length() > 0) {
        Log.i(logTag, "resolveAssetPath: file already extracted at ${targetPath.absolutePath}")
        return targetPath.absolutePath
      }
      val parentDir = targetPath.parentFile ?: targetBaseDir
      parentDir.mkdirs()

      try {
        assetManager.open(assetPath).use { input ->
          FileOutputStream(targetPath).use { output ->
            input.copyTo(output, bufferSize = 64 * 1024)
          }
        }
        Log.i(logTag, "resolveAssetPath: extracted file to ${targetPath.absolutePath}")
        return targetPath.absolutePath
      } catch (e: java.io.FileNotFoundException) {
        val parentAssetPath = pathParts.dropLast(1).joinToString("/")
        if (parentAssetPath.isNotEmpty()) {
          try {
            copyAssetRecursively(assetManager, parentAssetPath, parentDir)
            if (targetPath.exists() && targetPath.isFile) {
              return targetPath.absolutePath
            }
            throw IllegalArgumentException(
              "File not found after copying parent directory: $assetPath",
            )
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
              input.copyTo(output, bufferSize = 64 * 1024)
            }
          }
        }
      } catch (_: Exception) {
        try {
          assetManager.open(assetFilePath).use { input ->
            FileOutputStream(targetFile).use { output ->
              input.copyTo(output, bufferSize = 64 * 1024)
            }
          }
        } catch (fileException: Exception) {
          throw IllegalArgumentException("Failed to copy asset: $assetFilePath", fileException)
        }
      }
    }
  }
}
