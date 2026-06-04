package com.sherpaonnx.assets.core

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.google.android.play.core.assetpacks.AssetPackManagerFactory
import com.google.android.play.core.assetpacks.AssetPackState
import com.google.android.play.core.assetpacks.model.AssetPackStatus

internal class AssetPackDelivery(
  private val context: ReactApplicationContext,
  private val logTag: String,
) {
  fun fetchAssetPack(packName: String, promise: Promise) {
    try {
      val manager = AssetPackManagerFactory.getInstance(context)
      Log.i(logTag, "fetchAssetPack: packName=$packName")
      manager
        .fetch(listOf(packName))
        .addOnSuccessListener {
          Log.i(logTag, "fetchAssetPack: requested $packName")
          promise.resolve(true)
        }
        .addOnFailureListener { e ->
          Log.w(logTag, "fetchAssetPack failed: ${e.message}")
          promise.reject("PAD_FETCH_FAILED", e.message ?: "fetch failed", e)
        }
    } catch (e: Exception) {
      Log.w(logTag, "fetchAssetPack error: ${e.message}")
      promise.reject("PAD_FETCH_ERROR", e.message ?: "fetch error", e)
    }
  }

  fun getAssetPackState(packName: String, promise: Promise) {
    try {
      val manager = AssetPackManagerFactory.getInstance(context)
      manager
        .getPackStates(listOf(packName))
        .addOnSuccessListener { packStates ->
          val state = packStates.packStates()[packName]
          if (state == null) {
            promise.resolve(notInstalledMap(packName))
          } else {
            promise.resolve(stateToMap(state))
          }
        }
        .addOnFailureListener { e ->
          Log.w(logTag, "getAssetPackState failed: ${e.message}")
          promise.reject("PAD_STATE_FAILED", e.message ?: "state failed", e)
        }
    } catch (e: Exception) {
      Log.w(logTag, "getAssetPackState error: ${e.message}")
      promise.reject("PAD_STATE_ERROR", e.message ?: "state error", e)
    }
  }

  private fun notInstalledMap(packName: String) =
    Arguments.createMap().apply {
      putString("packName", packName)
      putString("status", statusName(AssetPackStatus.NOT_INSTALLED))
      putDouble("bytesDownloaded", 0.0)
      putDouble("totalBytes", 0.0)
      putInt("errorCode", 0)
    }

  fun removeAssetPack(packName: String, promise: Promise) {
    try {
      val manager = AssetPackManagerFactory.getInstance(context)
      Log.i(logTag, "removeAssetPack: packName=$packName")
      manager
        .removePack(packName)
        .addOnSuccessListener {
          // Play Core removePack() completes with Void — no bytes-removed metric.
          Log.i(logTag, "removeAssetPack: $packName removed")
          promise.resolve(0.0)
        }
        .addOnFailureListener { e ->
          Log.w(logTag, "removeAssetPack failed: ${e.message}")
          promise.reject("PAD_REMOVE_FAILED", e.message ?: "remove failed", e)
        }
    } catch (e: Exception) {
      Log.w(logTag, "removeAssetPack error: ${e.message}")
      promise.reject("PAD_REMOVE_ERROR", e.message ?: "remove error", e)
    }
  }

  private fun stateToMap(state: AssetPackState) =
    Arguments.createMap().apply {
      putString("packName", state.name())
      putString("status", statusName(state.status()))
      putDouble("bytesDownloaded", state.bytesDownloaded().toDouble())
      putDouble("totalBytes", state.totalBytesToDownload().toDouble())
      putInt("errorCode", state.errorCode())
    }

  private fun statusName(status: Int): String =
    when (status) {
      AssetPackStatus.PENDING -> "pending"
      AssetPackStatus.DOWNLOADING -> "downloading"
      AssetPackStatus.TRANSFERRING -> "transferring"
      AssetPackStatus.COMPLETED -> "completed"
      AssetPackStatus.FAILED -> "failed"
      AssetPackStatus.CANCELED -> "canceled"
      AssetPackStatus.WAITING_FOR_WIFI -> "waiting_for_wifi"
      AssetPackStatus.NOT_INSTALLED -> "not_installed"
      else -> "unknown"
    }
}
