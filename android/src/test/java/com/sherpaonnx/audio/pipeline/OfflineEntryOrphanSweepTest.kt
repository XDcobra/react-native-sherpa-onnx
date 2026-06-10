package com.sherpaonnx.audio.pipeline

import java.io.File
import kotlin.io.path.createTempDirectory
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OfflineEntryOrphanSweepTest {

  @Test
  fun cleanupOrphanedOrchestrationFiles_deletesOnlyExpiredOrchFiles() {
    val dir = createTempDirectory("orch_sweep_test").toFile()
    try {
      val oldOrch = File(dir, "orch_old_acc.wav")
      val freshOrch = File(dir, "orch_fresh_acc.wav")
      val oldNonOrch = File(dir, "pa_off_old.f32")

      oldOrch.writeText("old")
      freshOrch.writeText("fresh")
      oldNonOrch.writeText("other")

      val now = System.currentTimeMillis()
      oldOrch.setLastModified(now - 10_000L)
      freshOrch.setLastModified(now)
      oldNonOrch.setLastModified(now - 10_000L)

      OfflineEntry.cleanupOrphanedOrchestrationFiles(dir, maxAgeMs = 1_000L)

      assertFalse("expired orch_* file should be deleted", oldOrch.exists())
      assertTrue("fresh orch_* file should be kept", freshOrch.exists())
      assertTrue("non-orch file should not be touched", oldNonOrch.exists())
    } finally {
      dir.deleteRecursively()
    }
  }
}
