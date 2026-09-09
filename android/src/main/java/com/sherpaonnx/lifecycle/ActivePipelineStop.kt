package com.sherpaonnx.lifecycle

import android.util.Log
import com.sherpaonnx.audio.pipeline.StreamingPipelineRegistry
import java.util.concurrent.ConcurrentHashMap

/**
 * Shared stop-before-unload for instanceId → pipelineId maps.
 *
 * Callers that own a live/streaming pipeline for a native engine should stop
 * (and optionally remove) the pipeline before [NativeInstanceGate.releaseWhenIdle].
 */
internal object ActivePipelineStop {
  private const val TAG = "SherpaOnnx:pipeline-stop"

  /**
   * @param removeFromRegistry true = VAD-style explicit [StreamingPipelineRegistry.remove];
   *   false = Enh/Sep-style stop + poll until watchCompletion drops the entry.
   * @return stopped pipelineId, or null if none was tracked for [instanceId].
   */
  fun stopForInstance(
    instanceId: String,
    activeByInstance: ConcurrentHashMap<String, String>,
    timeoutMs: Long = 120_000L,
    removeFromRegistry: Boolean = false,
  ): String? {
    val pipelineId = activeByInstance.remove(instanceId) ?: return null
    try {
      StreamingPipelineRegistry.stop(pipelineId)
    } catch (e: Exception) {
      logW("stop failed instanceId=$instanceId pipelineId=$pipelineId msg=${e.message}")
    }
    if (removeFromRegistry) {
      try {
        StreamingPipelineRegistry.remove(pipelineId)
      } catch (e: Exception) {
        logW("remove failed instanceId=$instanceId pipelineId=$pipelineId msg=${e.message}")
      }
      return pipelineId
    }
    awaitPipelineStopped(pipelineId, timeoutMs)
    return pipelineId
  }

  private fun awaitPipelineStopped(pipelineId: String, timeoutMs: Long) {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < deadline) {
      if (StreamingPipelineRegistry.get(pipelineId) == null) {
        return
      }
      try {
        Thread.sleep(50)
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
        return
      }
    }
    logW("await timeout pipelineId=$pipelineId timeoutMs=$timeoutMs stillRegistered=true")
  }

  private fun logW(msg: String) {
    try {
      Log.w(TAG, msg)
    } catch (_: Throwable) {
      System.err.println("W/$TAG: $msg")
    }
  }
}
