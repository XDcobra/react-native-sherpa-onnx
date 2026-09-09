package com.sherpaonnx.lifecycle

import android.util.Log
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Feature-agnostic use-count gate: prevents native engine `.release()` / destroy
 * while createStream/compute/decode/generate is still running on another thread
 * (proven UAF → SIGSEGV when unload races live OfflineLive workers).
 *
 * Key: opaque [String]. Prefer [keyFor] for Java engine wrappers, or a stable
 * `instanceId` for JNI-lookup engines.
 *
 * Adoption: SLID, Offline STT, TTS, Offline Punctuation, Speaker Embedding,
 * Offline/Online Enhancement, Separation. Prefer [ActivePipelineStop] before
 * [releaseWhenIdle] when a live/streaming pipeline is tracked for the instance.
 * Flush/Reset hang for sibling StreamingPipelineWorkers is a separate track —
 * OfflineLive base already covers OfflineLive subclasses.
 */
internal object NativeInstanceGate {
  private const val TAG = "SherpaOnnx:native-gate"

  private class State {
    val lock = Object()
    val inFlight = AtomicInteger(0)
    @Volatile var released: Boolean = false
  }

  private val states = ConcurrentHashMap<String, State>()

  private fun logW(msg: String) {
    try {
      Log.w(TAG, msg)
    } catch (_: Throwable) {
      System.err.println("W/$TAG: $msg")
    }
  }

  private fun logE(msg: String) {
    try {
      Log.e(TAG, msg)
    } catch (_: Throwable) {
      System.err.println("E/$TAG: $msg")
    }
  }

  /** Stable key for a Java-held native engine wrapper (identity-based). */
  fun keyFor(engine: Any): String = "obj:${System.identityHashCode(engine)}"

  private fun stateFor(key: String): State =
    states.getOrPut(key) { State() }

  fun inFlight(key: String): Int =
    states[key]?.inFlight?.get() ?: 0

  /**
   * @return false if [releaseWhenIdle] already marked this instance released —
   * caller must not touch the native object.
   */
  fun beginUse(key: String): Boolean {
    val s = stateFor(key)
    synchronized(s.lock) {
      if (s.released) return false
      s.inFlight.incrementAndGet()
      return true
    }
  }

  fun endUse(key: String) {
    val s = states[key] ?: return
    synchronized(s.lock) {
      s.inFlight.decrementAndGet()
      s.lock.notifyAll()
    }
  }

  /**
   * Marks the instance released (blocks new [beginUse]), waits for in-flight
   * ops to finish, then runs [releaseNative].
   *
   * @return true if [releaseNative] ran; false on wait timeout (native left
   * alive to avoid crashing — caller should log).
   */
  fun releaseWhenIdle(
    key: String,
    waitMs: Long = 60_000L,
    releaseNative: () -> Unit,
  ): Boolean {
    val s = stateFor(key)
    synchronized(s.lock) {
      s.released = true
      val inFlightAtStart = s.inFlight.get()
      if (inFlightAtStart > 0) {
        logW(
          "releaseWhenIdle waiting key=$key inFlight=$inFlightAtStart " +
            "thread=${Thread.currentThread().name}",
        )
      }
      val deadlineNs = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(waitMs)
      while (s.inFlight.get() > 0) {
        val remainingMs =
          TimeUnit.NANOSECONDS.toMillis(deadlineNs - System.nanoTime())
        if (remainingMs <= 0L) {
          logE(
            "UNLOAD_WAIT_TIMEOUT key=$key inFlight=${s.inFlight.get()} " +
              "skipNativeRelease=true",
          )
          return false
        }
        s.lock.wait(remainingMs.coerceAtMost(250L))
      }
      try {
        releaseNative()
      } finally {
        states.remove(key, s)
      }
      return true
    }
  }
}
