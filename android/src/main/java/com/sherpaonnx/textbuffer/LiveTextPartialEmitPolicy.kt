// Sync vs latest-wins Handler batch for pipelineLiveTextPartial.
// Perf keep: docs/internal/textbuffer/performance/textbuffer-perf-plan.md (D-A4).
package com.sherpaonnx.textbuffer

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.sherpaonnx.text.pipeline.LiveTextEntry
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

object LiveTextPartialEmitPolicy {
  enum class Mode {
    /** Baseline: emit on calling thread immediately (after interval gate). */
    Sync,
    /** Coalesce to latest payload; one main-looper Binder emit per schedule. */
    Batched,
  }

  /** Default Batched; Sync retained for harness A/B.
   * Perf keep: docs/internal/textbuffer/performance/textbuffer-perf-plan.md (D-A4). */
  @Volatile
  var mode: Mode = Mode.Batched

  private val lastEmitAtMs = ConcurrentHashMap<String, Long>()
  private val pending = ConcurrentHashMap<String, Pending>()
  private val scheduled = ConcurrentHashMap.newKeySet<String>()
  private val mainHandler = Handler(Looper.getMainLooper())
  private val emitCount = AtomicLong(0)

  fun resetCounters() {
    emitCount.set(0)
  }

  fun emitCount(): Long = emitCount.get()

  fun clearThrottleState() {
    lastEmitAtMs.clear()
    pending.clear()
    scheduled.clear()
  }

  fun maybeEmit(
    context: ReactApplicationContext,
    entry: LiveTextEntry,
    source: String,
  ) {
    if (!entry.emitPartialEvents) return

    val now = SystemClock.elapsedRealtime()
    val minInterval = entry.partialEventMinIntervalMs.coerceAtLeast(0L)
    val last = lastEmitAtMs[entry.bufferId] ?: 0L
    if (minInterval > 0L && last > 0L && (now - last) < minInterval) {
      return
    }
    lastEmitAtMs[entry.bufferId] = now

    val snap =
      Pending(
        liveBufferId = entry.bufferId,
        source = source,
        utf16Length = entry.partialUtf16Length,
        revision = entry.revision,
      )

    when (mode) {
      Mode.Sync -> emitNow(context, snap)
      Mode.Batched -> {
        pending[entry.bufferId] = snap
        if (!scheduled.add(entry.bufferId)) return
        mainHandler.post {
          scheduled.remove(entry.bufferId)
          val latest = pending.remove(entry.bufferId) ?: return@post
          emitNow(context, latest)
        }
      }
    }
  }

  /** Drain batched emits (no-op for Sync). Harness helper for fair e2e wall. */
  fun flushAndEmit(context: ReactApplicationContext, timeoutMs: Long = 2000L): Boolean {
    if (mode != Mode.Batched) return true
    val latch = CountDownLatch(1)
    mainHandler.post {
      val leftovers = HashMap(pending)
      pending.clear()
      scheduled.clear()
      for ((_, snap) in leftovers) {
        emitNow(context, snap)
      }
      latch.countDown()
    }
    return latch.await(timeoutMs, TimeUnit.MILLISECONDS)
  }

  private fun emitNow(context: ReactApplicationContext, snap: Pending) {
    try {
      val eventEmitter =
        context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      val payload = Arguments.createMap()
      payload.putString("liveBufferId", snap.liveBufferId)
      payload.putString("source", snap.source)
      payload.putInt("utf16Length", snap.utf16Length)
      payload.putInt("revision", snap.revision)
      eventEmitter.emit("pipelineLiveTextPartial", payload)
      emitCount.incrementAndGet()
    } catch (_: Exception) {
      // JS bridge may be unavailable during teardown.
    }
  }

  private data class Pending(
    val liveBufferId: String,
    val source: String,
    val utf16Length: Int,
    val revision: Int,
  )
}
