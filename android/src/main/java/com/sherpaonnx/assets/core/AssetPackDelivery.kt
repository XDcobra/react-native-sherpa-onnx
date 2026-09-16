package com.sherpaonnx.assets.core

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.google.android.play.core.assetpacks.AssetPackManagerFactory
import com.google.android.play.core.assetpacks.AssetPackState
import com.google.android.play.core.assetpacks.AssetPackStateUpdateListener
import com.google.android.play.core.assetpacks.model.AssetPackErrorCode
import com.google.android.play.core.assetpacks.model.AssetPackStatus

internal class AssetPackDelivery(
  private val context: ReactApplicationContext,
  private val logTag: String,
) {
  private val pendingEnsures = mutableMapOf<String, MutableList<Promise>>()
  private val refetchAttempted = mutableSetOf<String>()
  private val wifiConfirmShown = mutableSetOf<String>()
  private val stallHandlers = mutableMapOf<String, Runnable>()
  private val lastProgressBytes = mutableMapOf<String, Long>()
  private var packStateListener: AssetPackStateUpdateListener? = null
  private val mainHandler = Handler(Looper.getMainLooper())

  companion object {
    /** Reject if downloaded bytes do not advance for this long while waiting. */
    private const val DEFAULT_STALL_TIMEOUT_MS = 60_000L

    /** Historic AssetPackErrorCode.PLAY_STORE_NOT_FOUND; still returned by Play at runtime. */
    private const val PLAY_STORE_NOT_FOUND_LEGACY = -11
  }

  private val stallTimeoutMsByPack = mutableMapOf<String, Long>()

  fun fetchAssetPack(packName: String, promise: Promise) {
    try {
      val manager = AssetPackManagerFactory.getInstance(context)
      Log.i(logTag, "[SherpaOnnx PAD] fetchAssetPack pack=$packName")
      manager
        .fetch(listOf(packName))
        .addOnSuccessListener {
          Log.i(logTag, "[SherpaOnnx PAD] fetchAssetPack requested pack=$packName")
          promise.resolve(true)
        }
        .addOnFailureListener { e ->
          Log.w(logTag, "[SherpaOnnx PAD] fetchAssetPack failed: ${e.message}")
          promise.reject(padFailureCode(e), e.message ?: "fetch failed", e)
        }
    } catch (e: Exception) {
      Log.w(logTag, "[SherpaOnnx PAD] fetchAssetPack error: ${e.message}")
      promise.reject(padFailureCode(e), e.message ?: "fetch error", e)
    }
  }

  fun ensureAssetPackReady(
    packName: String,
    stallTimeoutMs: Double,
    promise: Promise,
  ) {
    try {
      val timeoutMs =
        if (stallTimeoutMs > 0) stallTimeoutMs.toLong() else DEFAULT_STALL_TIMEOUT_MS
      stallTimeoutMsByPack[packName] = timeoutMs
      synchronized(pendingEnsures) {
        pendingEnsures.getOrPut(packName) { mutableListOf() }.add(promise)
      }
      ensureListenerRegistered()
      armStallWatchdog(packName)
      val manager = AssetPackManagerFactory.getInstance(context)
      Log.i(
        logTag,
        "[SherpaOnnx PAD] ensureAssetPackReady pack=$packName stallTimeoutMs=$timeoutMs",
      )
      manager
        .getPackStates(listOf(packName))
        .addOnSuccessListener { packStates ->
          val state = packStates.packStates()[packName]
          if (state == null) {
            Log.i(
              logTag,
              "[SherpaOnnx PAD] branch=not_installed_null pack=$packName → requestFetch",
            )
            emitProgress(notInstalledMap(packName))
            requestFetch(packName)
            return@addOnSuccessListener
          }
          handlePackState(state)
        }
        .addOnFailureListener { e ->
          Log.w(
            logTag,
            "[SherpaOnnx PAD] branch=getPackStates_failed pack=$packName msg=${e.message}",
          )
          failEnsures(packName, padFailureCode(e), e.message ?: "state failed")
        }
    } catch (e: Exception) {
      Log.w(logTag, "[SherpaOnnx PAD] ensureAssetPackReady error: ${e.message}")
      failEnsures(packName, padFailureCode(e), e.message ?: "ensure error")
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
    Log.i(logTag, "[SherpaOnnx PAD] branch=requestFetch pack=$packName")
    manager
      .fetch(listOf(packName))
      .addOnFailureListener { e ->
        Log.w(
          logTag,
          "[SherpaOnnx PAD] branch=fetch_failed pack=$packName msg=${e.message}",
        )
        failEnsures(packName, padFailureCode(e), e.message ?: "fetch failed")
      }
  }

  private fun handlePackState(state: AssetPackState) {
    val packName = state.name()
    val status = state.status()
    val bytes = state.bytesDownloaded()
    val line =
      "[SherpaOnnx PAD] pack=$packName status=${statusName(status)} " +
        "bytes=$bytes/${state.totalBytesToDownload()} " +
        "errorCode=${state.errorCode()}"
    when (status) {
      AssetPackStatus.DOWNLOADING,
      AssetPackStatus.TRANSFERRING,
      AssetPackStatus.PENDING,
      -> Log.d(logTag, line)
      else -> Log.i(logTag, line)
    }
    emitProgress(stateToMap(state))
    noteProgressBytes(packName, bytes)

    when (status) {
      AssetPackStatus.COMPLETED -> {
        Log.i(logTag, "[SherpaOnnx PAD] branch=completed pack=$packName")
        completeEnsures(packName, state)
      }
      AssetPackStatus.FAILED,
      AssetPackStatus.CANCELED,
      -> handleFailedOrCanceled(packName, state)
      AssetPackStatus.NOT_INSTALLED -> {
        Log.i(logTag, "[SherpaOnnx PAD] branch=not_installed pack=$packName → requestFetch")
        requestFetch(packName)
      }
      AssetPackStatus.WAITING_FOR_WIFI -> {
        Log.i(logTag, "[SherpaOnnx PAD] branch=waiting_for_wifi pack=$packName")
        maybeShowWifiConfirmation(packName)
      }
      AssetPackStatus.REQUIRES_USER_CONFIRMATION -> {
        Log.i(logTag, "[SherpaOnnx PAD] branch=requires_user_confirmation pack=$packName")
        maybeShowWifiConfirmation(packName)
      }
      AssetPackStatus.PENDING,
      AssetPackStatus.DOWNLOADING,
      AssetPackStatus.TRANSFERRING,
      -> {
        // Keep waiting; stall watchdog covers silent hangs.
      }
      else -> {
        Log.i(
          logTag,
          "[SherpaOnnx PAD] branch=unknown_status pack=$packName status=$status — keep waiting",
        )
      }
    }
  }

  private fun handleFailedOrCanceled(packName: String, state: AssetPackState) {
    val errorCode = state.errorCode()
    val alreadyRetried: Boolean
    synchronized(pendingEnsures) {
      alreadyRetried = !refetchAttempted.add(packName)
    }
    if (!alreadyRetried) {
      Log.i(
        logTag,
        "[SherpaOnnx PAD] branch=refetch_after_failed pack=$packName " +
          "status=${statusName(state.status())} errorCode=$errorCode",
      )
      requestFetch(packName)
      armStallWatchdog(packName)
      return
    }
    Log.w(
      logTag,
      "[SherpaOnnx PAD] branch=failed_terminal pack=$packName " +
        "status=${statusName(state.status())} errorCode=$errorCode",
    )
    failEnsures(
      packName,
      deliveryFailureCode(state.status(), errorCode),
      "Asset pack $packName ${statusName(state.status())} (errorCode=$errorCode)",
    )
  }

  private fun maybeShowWifiConfirmation(packName: String) {
    synchronized(pendingEnsures) {
      if (!wifiConfirmShown.add(packName)) {
        Log.d(
          logTag,
          "[SherpaOnnx PAD] branch=wifi_confirm_skip pack=$packName reason=already_shown",
        )
        return
      }
    }
    val activity: Activity? = context.currentActivity
    if (activity == null) {
      Log.w(
        logTag,
        "[SherpaOnnx PAD] branch=wifi_confirm_skip pack=$packName reason=no_activity",
      )
      return
    }
    try {
      Log.i(logTag, "[SherpaOnnx PAD] branch=wifi_confirm pack=$packName")
      AssetPackManagerFactory
        .getInstance(context)
        .showConfirmationDialog(activity)
    } catch (e: Exception) {
      Log.w(
        logTag,
        "[SherpaOnnx PAD] branch=wifi_confirm_failed pack=$packName msg=${e.message}",
      )
    }
  }

  private fun noteProgressBytes(packName: String, bytes: Long) {
    val prev = lastProgressBytes[packName]
    if (prev == null || bytes > prev) {
      lastProgressBytes[packName] = bytes
      armStallWatchdog(packName)
    }
  }

  private fun armStallWatchdog(packName: String) {
    val timeoutMs = stallTimeoutMsByPack[packName] ?: DEFAULT_STALL_TIMEOUT_MS
    synchronized(stallHandlers) {
      stallHandlers.remove(packName)?.let { mainHandler.removeCallbacks(it) }
      val runnable =
        Runnable {
          Log.w(
            logTag,
            "[SherpaOnnx PAD] branch=stall_timeout pack=$packName " +
              "bytes=${lastProgressBytes[packName] ?: 0} timeoutMs=$timeoutMs",
          )
          failEnsures(
            packName,
            "PAD_STALLED",
            "Asset pack $packName stalled (no progress for ${timeoutMs}ms)",
          )
        }
      stallHandlers[packName] = runnable
      mainHandler.postDelayed(runnable, timeoutMs)
    }
  }

  private fun clearStallWatchdog(packName: String) {
    synchronized(stallHandlers) {
      stallHandlers.remove(packName)?.let { mainHandler.removeCallbacks(it) }
    }
  }

  private fun completeEnsures(packName: String, state: AssetPackState) {
    clearStallWatchdog(packName)
    val promises: List<Promise>
    synchronized(pendingEnsures) {
      promises = pendingEnsures.remove(packName) ?: emptyList()
      refetchAttempted.remove(packName)
      wifiConfirmShown.remove(packName)
      lastProgressBytes.remove(packName)
      stallTimeoutMsByPack.remove(packName)
      if (pendingEnsures.isEmpty()) {
        unregisterListenerIfIdle()
      }
    }
    Log.i(
      logTag,
      "[SherpaOnnx PAD] ensureReady pack=$packName status=completed " +
        "waiters=${promises.size} next=app_calls_getAssetPackPath",
    )
    val map = stateToMap(state)
    for (p in promises) {
      p.resolve(map)
    }
  }

  private fun failEnsures(packName: String, code: String, message: String) {
    clearStallWatchdog(packName)
    val promises: List<Promise>
    synchronized(pendingEnsures) {
      promises = pendingEnsures.remove(packName) ?: emptyList()
      refetchAttempted.remove(packName)
      wifiConfirmShown.remove(packName)
      lastProgressBytes.remove(packName)
      stallTimeoutMsByPack.remove(packName)
      if (pendingEnsures.isEmpty()) {
        unregisterListenerIfIdle()
      }
    }
    Log.w(
      logTag,
      "[SherpaOnnx PAD] failEnsures pack=$packName code=$code waiters=${promises.size} msg=$message",
    )
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
          promise.reject(padFailureCode(e), e.message ?: "state failed", e)
        }
    } catch (e: Exception) {
      Log.w(logTag, "getAssetPackState error: ${e.message}")
      promise.reject(padFailureCode(e), e.message ?: "state error", e)
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
      Log.i(logTag, "[SherpaOnnx PAD] removeAssetPack pack=$packName")
      manager
        .removePack(packName)
        .addOnSuccessListener {
          Log.i(logTag, "[SherpaOnnx PAD] removeAssetPack removed pack=$packName")
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
      AssetPackStatus.REQUIRES_USER_CONFIRMATION -> "waiting_for_wifi"
      AssetPackStatus.NOT_INSTALLED -> "not_installed"
      else -> "unknown"
    }

  private fun deliveryFailureCode(status: Int, errorCode: Int): String {
    when (errorCode) {
      AssetPackErrorCode.NETWORK_ERROR -> return "PAD_NETWORK_ERROR"
      AssetPackErrorCode.ACCESS_DENIED -> return "PAD_ACCESS_DENIED"
      // PLAY_STORE_NOT_FOUND (-11) existed in older Play Core docs but is absent from
      // asset-delivery 2.3.0's AssetPackErrorCode; keep the numeric sentinel.
      AssetPackErrorCode.API_NOT_AVAILABLE,
      AssetPackErrorCode.APP_UNAVAILABLE,
      AssetPackErrorCode.APP_NOT_OWNED,
      AssetPackErrorCode.UNRECOGNIZED_INSTALLATION,
      PLAY_STORE_NOT_FOUND_LEGACY,
      -> return "PAD_PLAY_UNAVAILABLE"
      AssetPackErrorCode.PACK_UNAVAILABLE -> return "PAD_PACK_UNAVAILABLE"
      AssetPackErrorCode.INSUFFICIENT_STORAGE -> return "PAD_INSUFFICIENT_STORAGE"
    }
    return "PAD_DELIVERY_${statusName(status).uppercase()}"
  }

  private fun padFailureCode(error: Throwable): String {
    val msg = (error.message ?: "").lowercase()
    if (
      msg.contains("play store") ||
        msg.contains("play_store") ||
        msg.contains("api_not_available") ||
        msg.contains("not available") ||
        msg.contains("binder has died")
    ) {
      return "PAD_PLAY_UNAVAILABLE"
    }
    if (msg.contains("network")) {
      return "PAD_NETWORK_ERROR"
    }
    return "PAD_ENSURE_FAILED"
  }
}
