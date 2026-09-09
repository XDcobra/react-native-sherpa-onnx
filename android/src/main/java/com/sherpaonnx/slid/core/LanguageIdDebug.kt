package com.sherpaonnx.slid.core

import android.util.Log
import com.sherpaonnx.BuildConfig
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * DEV lifecycle / compute-overlap logging for SLID.
 * Tag filter: `adb logcat -s SherpaOnnx:slid-dbg:I *:S`
 *
 * Tracks overlapping createStream/compute on the same native instance and
 * lifecycle timing around pipeline stop/release. Gated by [BuildConfig.DEBUG].
 */
internal object LanguageIdDebug {
  const val TAG = "SherpaOnnx:slid-dbg"

  private val enabled: Boolean
    get() = BuildConfig.DEBUG

  private val inFlightBySlid = ConcurrentHashMap<Int, AtomicInteger>()
  private val seq = AtomicLong(0)

  fun nextOpId(): Long = seq.incrementAndGet()

  fun inFlightFor(slidIdentity: Int): Int =
    inFlightBySlid[slidIdentity]?.get() ?: 0

  fun computeEnter(slidIdentity: Int, where: String, opId: Long, detail: String): Int {
    val n = inFlightBySlid.getOrPut(slidIdentity) { AtomicInteger(0) }.incrementAndGet()
    if (!enabled) return n
    val level = if (n > 1) Log.ERROR else Log.INFO
    Log.println(
      level,
      TAG,
      "compute.enter op=$opId where=$where slid=$slidIdentity inFlight=$n " +
        "thread=${Thread.currentThread().name} $detail",
    )
    if (n > 1) {
      Log.e(
        TAG,
        "COMPUTE_OVERLAP op=$opId where=$where slid=$slidIdentity inFlight=$n " +
          "thread=${Thread.currentThread().name}",
      )
    }
    return n
  }

  fun computeLeave(slidIdentity: Int, where: String, opId: Long, detail: String) {
    val counter = inFlightBySlid[slidIdentity]
    val n = counter?.decrementAndGet() ?: -1
    if (!enabled) return
    Log.i(
      TAG,
      "compute.leave op=$opId where=$where slid=$slidIdentity inFlight=$n " +
        "thread=${Thread.currentThread().name} $detail",
    )
  }

  fun lifecycle(event: String, detail: String) {
    if (!enabled) return
    Log.i(TAG, "lifecycle.$event thread=${Thread.currentThread().name} $detail")
  }

  fun sample(detail: String) {
    if (!enabled) return
    Log.i(TAG, "sample $detail")
  }

  fun warn(detail: String) {
    if (!enabled) return
    Log.w(TAG, detail)
  }
}
