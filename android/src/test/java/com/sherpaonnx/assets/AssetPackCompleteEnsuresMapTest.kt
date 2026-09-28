package com.sherpaonnx.assets

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Documents the RN WritableMap single-consume contract that crashed
 * [com.sherpaonnx.assets.core.AssetPackDelivery.completeEnsures] when one map
 * was passed to every waiter Promise (Crashlytics c266f6a8 / Map was consumed).
 */
class AssetPackCompleteEnsuresMapTest {

  /** Stand-in for WritableMap: first resolve consumes; second throws. */
  private class ConsumableMap {
    @Volatile private var consumed = false

    fun consume() {
      if (consumed) {
        throw IllegalStateException("ObjectAlreadyConsumedException: Map was consumed")
      }
      consumed = true
    }
  }

  private class RecordingPromise {
    var resolved = false
      private set

    fun resolve(map: ConsumableMap) {
      map.consume()
      resolved = true
    }
  }

  @Test
  fun sharedMap_secondWaiterThrows() {
    val shared = ConsumableMap()
    val waiters = listOf(RecordingPromise(), RecordingPromise())

    val thrown =
      assertThrows(IllegalStateException::class.java) {
        for (p in waiters) {
          p.resolve(shared)
        }
      }
    assertTrue(thrown.message!!.contains("Map was consumed"))
    assertTrue(waiters[0].resolved)
    assertEquals(false, waiters[1].resolved)
  }

  @Test
  fun freshMapPerWaiter_allResolve() {
    val waiters = listOf(RecordingPromise(), RecordingPromise(), RecordingPromise())
    // Mirrors fixed completeEnsures: p.resolve(stateToMap(state)) per waiter.
    for (p in waiters) {
      p.resolve(ConsumableMap())
    }
    assertEquals(3, waiters.count { it.resolved })
  }
}
