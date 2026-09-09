package com.sherpaonnx.lifecycle

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Verifies unload-during-in-flight semantics that previously crashed SLID
 * (release must wait for endUse; beginUse rejected after release starts).
 */
class NativeInstanceGateTest {

  @Test
  fun releaseWhenIdle_waitsForInFlightUse() {
    val engine = Any()
    val key = NativeInstanceGate.keyFor(engine)
    assertTrue(NativeInstanceGate.beginUse(key))

    val releasedNative = AtomicBoolean(false)
    val releaseStartedAt = AtomicLong(0L)
    val releaseFinishedAt = AtomicLong(0L)
    val endUseAt = AtomicLong(0L)
    val unloadDone = CountDownLatch(1)

    Thread {
      releaseStartedAt.set(System.nanoTime())
      val ok = NativeInstanceGate.releaseWhenIdle(key, waitMs = 5_000L) {
        releasedNative.set(true)
      }
      releaseFinishedAt.set(System.nanoTime())
      assertTrue(ok)
      unloadDone.countDown()
    }.start()

    // Give unload thread time to enter wait while inFlight=1.
    Thread.sleep(200)
    assertFalse("native must not release while in flight", releasedNative.get())
    assertEquals(1, NativeInstanceGate.inFlight(key))

    endUseAt.set(System.nanoTime())
    NativeInstanceGate.endUse(key)

    assertTrue(unloadDone.await(5, TimeUnit.SECONDS))
    assertTrue(releasedNative.get())
    assertTrue(
      "releaseNative must run after endUse",
      releaseFinishedAt.get() >= endUseAt.get(),
    )
    // After successful release the gate entry is removed; a new beginUse on the
    // same key starts a fresh lifecycle (callers must not touch the freed native).
  }

  @Test
  fun beginUse_rejectsAfterReleaseStarts() {
    val key = NativeInstanceGate.keyFor(Any())
    assertTrue(NativeInstanceGate.beginUse(key))

    val sawReject = AtomicBoolean(false)
    val unloadEntered = CountDownLatch(1)
    val holdCompute = CountDownLatch(1)

    Thread {
      unloadEntered.countDown()
      NativeInstanceGate.releaseWhenIdle(key, waitMs = 5_000L) {}
    }.start()

    assertTrue(unloadEntered.await(2, TimeUnit.SECONDS))
    Thread.sleep(50)
    assertFalse(NativeInstanceGate.beginUse(key))
    sawReject.set(true)

    holdCompute.countDown()
    NativeInstanceGate.endUse(key)
    assertTrue(sawReject.get())
  }

  @Test
  fun keyFor_isStablePerIdentity() {
    val a = Any()
    val b = Any()
    assertEquals(NativeInstanceGate.keyFor(a), NativeInstanceGate.keyFor(a))
    assertTrue(NativeInstanceGate.keyFor(a) != NativeInstanceGate.keyFor(b))
  }

  @Test
  fun releaseWhenIdle_timeoutSkipsNativeRelease() {
    val key = "test-timeout-${System.nanoTime()}"
    assertTrue(NativeInstanceGate.beginUse(key))
    val releaseCount = AtomicInteger(0)

    val ok = NativeInstanceGate.releaseWhenIdle(key, waitMs = 150L) {
      releaseCount.incrementAndGet()
    }

    assertFalse(ok)
    assertEquals(0, releaseCount.get())
    // Leave the stuck use so we don't poison other tests: endUse then drain.
    NativeInstanceGate.endUse(key)
    // State may still be marked released with leftover entry; use a unique key above.
  }
}
