package com.sherpaonnx.assets.core

import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.google.android.play.core.assetpacks.AssetPackManagerFactory
import com.google.android.play.core.assetpacks.model.AssetPackStatus
import com.google.android.play.core.assetpacks.model.AssetPackStorageMethod
import java.io.File

/** Resolves the PAD pack `…/models` directory (STORAGE_FILES only; content not inspected). */
internal class AssetPackLocator(
  private val context: ReactApplicationContext,
  private val logTag: String,
) {
  private fun archiveCountInDir(dir: File): Int {
    if (!dir.isDirectory) {
      return 0
    }
    return dir
      .listFiles()
      ?.count { file ->
        file.isFile &&
          (file.name.endsWith(".tar.zst") || file.name.endsWith(".tar.bz2"))
      }
      ?: 0
  }

  private fun packStatusName(status: Int): String =
    when (status) {
      AssetPackStatus.PENDING -> "pending"
      AssetPackStatus.DOWNLOADING -> "downloading"
      AssetPackStatus.TRANSFERRING -> "transferring"
      AssetPackStatus.COMPLETED -> "completed"
      AssetPackStatus.FAILED -> "failed"
      AssetPackStatus.CANCELED -> "canceled"
      AssetPackStatus.WAITING_FOR_WIFI -> "waiting_for_wifi"
      AssetPackStatus.NOT_INSTALLED -> "not_installed"
      else -> "unknown($status)"
    }

  private fun storageMethodName(method: Int): String =
    when (method) {
      AssetPackStorageMethod.APK_ASSETS -> "APK_ASSETS"
      AssetPackStorageMethod.STORAGE_FILES -> "STORAGE_FILES"
      else -> "unknown($method)"
    }

  fun getAssetPackPath(packName: String, promise: Promise) {
    try {
      val assetPackManager = AssetPackManagerFactory.getInstance(context)
      assetPackManager
        .getPackStates(listOf(packName))
        .addOnSuccessListener { packStates ->
          val state = packStates.packStates()[packName]
          val statusLabel = state?.let { packStatusName(it.status()) } ?: "null"

          var location = assetPackManager.getPackLocation(packName)
          if (location == null) {
            location = assetPackManager.packLocations?.get(packName)
          }

          if (location == null) {
            Log.i(
              logTag,
              "[SherpaOnnx PAD] getAssetPackPath pack=$packName path=null status=$statusLabel " +
                "hint=call ensureAssetPackReady before getAssetPackPath; " +
                "ship archives must live under models/ in the on-demand asset pack module",
            )
            promise.resolve(null)
            return@addOnSuccessListener
          }

          val storageMethod = location.packStorageMethod()
          if (storageMethod != AssetPackStorageMethod.STORAGE_FILES) {
            Log.i(
              logTag,
              "[SherpaOnnx PAD] getAssetPackPath pack=$packName path=null storage=${storageMethodName(storageMethod)} " +
                "hint=on-demand packs resolve to assetsPath/models after download (STORAGE_FILES only)",
            )
            promise.resolve(null)
            return@addOnSuccessListener
          }

          val assetsPath = location.assetsPath()
          val packPath = location.path()
          val modelsDir =
            when {
              !assetsPath.isNullOrEmpty() ->
                File(assetsPath, "models").absolutePath
              !packPath.isNullOrEmpty() ->
                File(packPath, "assets/models").absolutePath
              else -> null
            }

          if (modelsDir == null) {
            Log.i(
              logTag,
              "[SherpaOnnx PAD] getAssetPackPath pack=$packName path=null status=$statusLabel " +
                "hint=pack location missing assetsPath and packPath",
            )
            promise.resolve(null)
            return@addOnSuccessListener
          }

          val archiveCount = archiveCountInDir(File(modelsDir))
          if (archiveCount == 0) {
            Log.i(
              logTag,
              "[SherpaOnnx PAD] getAssetPackPath pack=$packName path=$modelsDir archiveCount=0 " +
                "hint=ship archives under models/ in the asset pack module",
            )
          }
          promise.resolve(modelsDir)
        }
        .addOnFailureListener { e ->
          Log.w(
            logTag,
            "[SherpaOnnx PAD] getAssetPackPath pack=$packName failed: ${e.message}",
          )
          promise.resolve(null)
        }
    } catch (e: Exception) {
      Log.w(logTag, "[SherpaOnnx PAD] getAssetPackPath pack=$packName failed: ${e.message}")
      promise.resolve(null)
    }
  }
}
