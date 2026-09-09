package com.sherpaonnx.audio.pipeline

import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Guards the HybridData crash class: completion must not run on ForkJoinPool.
 * Without Robolectric we inject [StreamingPipelineRegistry.completionPoster].
 */
class StreamingPipelineRegistryCompletionTest {

  @After
  fun tearDown() {
    StreamingPipelineRegistry.clear()
    StreamingPipelineRegistry.resetCompletionPosterForTests()
  }

  @Test
  fun completionCallback_runsViaCompletionPoster_notOnPollThread() {
    val posterThreadName = "test-completion-poster"
    val callbackThread = CopyOnWriteArrayList<String>()
    val done = CountDownLatch(1)

    StreamingPipelineRegistry.completionPoster = { block ->
      Thread({
        block()
      }, posterThreadName).start()
    }

    val id = StreamingPipelineRegistry.registerAndStart(
      ImmediateFinishWorker("pipe_immediate"),
    ) { completion ->
      callbackThread.add(Thread.currentThread().name)
      assertEquals("completed", completion.reason)
      assertEquals("pipe_immediate", completion.pipelineId)
      done.countDown()
    }

    assertEquals("pipe_immediate", id)
    assertTrue("completion timed out", done.await(3, TimeUnit.SECONDS))
    assertEquals(listOf(posterThreadName), callbackThread.toList())
    // release happens on poster thread after callback
    assertNull(StreamingPipelineRegistry.get("pipe_immediate"))
  }

  @Test
  fun stop_reportsStoppedReason() {
    val done = CountDownLatch(1)
    val reason = CopyOnWriteArrayList<String>()

    StreamingPipelineRegistry.completionPoster = { block -> block() }

    val worker = LatchRunningWorker("pipe_stop")
    StreamingPipelineRegistry.registerAndStart(worker) { completion ->
      reason.add(completion.reason)
      done.countDown()
    }

    assertNotNull(StreamingPipelineRegistry.get("pipe_stop"))
    StreamingPipelineRegistry.stop("pipe_stop")
    worker.allowFinish()

    assertTrue(done.await(3, TimeUnit.SECONDS))
    assertEquals(listOf("stopped"), reason.toList())
  }

  /** Finishes as soon as [start] is called (fast-complete path that triggered the crash). */
  private class ImmediateFinishWorker(
    override val pipelineId: String,
  ) : StreamingPipelineWorker {
    private val running = AtomicBoolean(true)
    private val released = AtomicBoolean(false)

    override val isRunning: Boolean
      get() = running.get()

    override fun start() {
      running.set(false)
    }

    override fun stop() {
      running.set(false)
    }

    override fun flush(): CompletableFuture<Unit> = CompletableFuture.completedFuture(Unit)

    override fun reset(): CompletableFuture<Unit> = CompletableFuture.completedFuture(Unit)

    override fun getStatus(): StreamingPipelineStatus = StreamingPipelineStatus(
      isRunning = running.get(),
      chunksProcessed = 1,
      unitsRead = 0,
      unitsWritten = 0,
    )

    override fun release() {
      if (!released.compareAndSet(false, true)) {
        fail("release called more than once")
      }
    }
  }

  /** Stays running until [allowFinish] after an optional [stop]. */
  private class LatchRunningWorker(
    override val pipelineId: String,
  ) : StreamingPipelineWorker {
    private val running = AtomicBoolean(true)
    private val finishGate = CountDownLatch(1)
    private val startCount = AtomicInteger(0)

    override val isRunning: Boolean
      get() = running.get()

    override fun start() {
      startCount.incrementAndGet()
      Thread({
        finishGate.await(3, TimeUnit.SECONDS)
        running.set(false)
      }, "latch-worker-$pipelineId").start()
    }

    fun allowFinish() {
      finishGate.countDown()
    }

    override fun stop() {
      // keep running until allowFinish so watchCompletion can observe stopRequested
    }

    override fun flush(): CompletableFuture<Unit> = CompletableFuture.completedFuture(Unit)

    override fun reset(): CompletableFuture<Unit> = CompletableFuture.completedFuture(Unit)

    override fun getStatus(): StreamingPipelineStatus = StreamingPipelineStatus(
      isRunning = running.get(),
      chunksProcessed = 0,
      unitsRead = 0,
      unitsWritten = 0,
    )

    override fun release() {}
  }
}
