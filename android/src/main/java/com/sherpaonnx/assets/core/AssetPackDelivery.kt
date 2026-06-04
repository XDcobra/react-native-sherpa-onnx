package com.sherpaonnx.assets.core

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.google.android.play.core.assetpacks.AssetPackManagerFactory
import com.google.android.play.core.assetpacks.AssetPackState
import com.google.android.play.core.assetpacks.AssetPackStateUpdateListener
import com.google.android.play.core.assetpacks.model.AssetPackStatus

internal class AssetPackDelivery(
  private val context: ReactApplicationContext,
  private val logTag: String,
) {
  private val pendingEnsures = mutableMapOf<String, MutableList<Promise>>()
  private var packStateListener: AssetPackStateUpdateListener? = null

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

  fun ensureAssetPackReady(packName: String, promise: Promise) {
    try {
      synchronized(pendingEnsures) {
        pendingEnsures.getOrPut(packName) { mutableListOf() }.add(promise)
      }
      ensureListenerRegistered()
      val manager = AssetPackManagerFactory.getInstance(context)
      Log.i(logTag, "ensureAssetPackReady: packName=$packName")
      manager
        .getPackStates(listOf(packName))
        .addOnSuccessListener { packStates ->
          val state = packStates.packStates()[packName]
          if (state == null) {
            emitProgress(notInstalledMap(packName))
            requestFetch(packName)
            return@addOnSuccessListener
          }
          handlePackState(state)
        }
        .addOnFailureListener { e ->
          Log.w(logTag, "ensureAssetPackReady getPackStates failed: ${e.message}")
          failEnsures(packName, "PAD_ENSURE_FAILED", e.message ?: "state failed")
        }
    } catch (e: Exception) {
      Log.w(logTag, "ensureAssetPackReady error: ${e.message}")
      failEnsures(packName, "PAD_ENSURE_ERROR", e.message ?: "ensure error")
    }
  }

  private fun ensureListenerRegistered() {
    if (packStateListener != null) {
      return
    }
    val manager = AssetPackManagerFactory.getInstance(context)
    val listener =
      AssetPackStateUpdateListener { state ->
        handlePackState(state)
      }
    packStateListener = listener
    manager.registerListener(listener)
  }

  private fun requestFetch(packName: String) {
    val manager = AssetPackManagerFactory.getInstance(context)
    manager
      .fetch(listOf(packName))
      .addOnFailureListener { e ->
        Log.w(logTag, "ensureAssetPackReady fetch failed: ${e.message}")
        failEnsures(packName, "PAD_FETCH_FAILED", e.message ?: "fetch failed")
      }
  }

  private fun handlePackState(state: AssetPackState) {
    val packName = state.name()
    emitProgress(stateToMap(state))
    when (state.status()) {
      AssetPackStatus.COMPLETED -> completeEnsures(packName, state)
      AssetPackStatus.FAILED,
      AssetPackStatus.CANCELED,
      -> failEnsures(
        packName,
        "PAD_DELIVERY_${statusName(state.status()).uppercase()}",
        "Asset pack $packName ${statusName(state.status())} (errorCode=${state.errorCode()})",
      )
      AssetPackStatus.NOT_INSTALLED -> requestFetch(packName)
      else -> Unit
    }
  }

  private fun completeEnsures(packName: String, state: AssetPackState) {
    val promises: List<Promise>
    synchronized(pendingEnsures) {
      promises = pendingEnsures.remove(packName) ?: emptyList()
      if (pendingEnsures.isEmpty()) {
        unregisterListenerIfIdle()
      }
    }
    val map = stateToMap(state)
    for (p in promises) {
      p.resolve(map)
    }
  }

  private fun failEnsures(packName: String, code: String, message: String) {
    val promises: List<Promise>
    synchronized(pendingEnsures) {
      promises = pendingEnsures.remove(packName) ?: emptyList()
      if (pendingEnsures.isEmpty()) {
        unregisterListenerIfIdle()
      }
    }
    for (p in promises) {
      p.reject(code, message, null)
    }
  }

  private fun unregisterListenerIfIdle() {
    val listener = packStateListener ?: return
    try {
      AssetPackManagerFactory.getInstance(context).unregisterListener(listener)
    } catch (e: Exception) {
      Log.w(logTag, "unregisterListener failed: ${e.message}")
    }
    packStateListener = null
  }

  private fun emitProgress(map: com.facebook.react.bridge.WritableMap) {
    try {
      val eventEmitter =
        context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      eventEmitter.emit("sherpaAssetPackDeliveryProgress", map)
    } catch (_: Exception) {
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
