package com.xdcobra.voiceexample

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class CpuInfoModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "CpuInfo"

  @ReactMethod
  fun getCpuCoreCount(promise: Promise) {
    try {
      val count = Runtime.getRuntime().availableProcessors()
      promise.resolve(count)
    } catch (e: Exception) {
      promise.reject("CPU_INFO_ERROR", e.message, e)
    }
  }
}
