package com.sherpaonnx.tts.core

import java.util.concurrent.ConcurrentHashMap

internal class TtsEngineRepository {
  private val instances = ConcurrentHashMap<String, TtsEngineInstance>()

  operator fun get(instanceId: String): TtsEngineInstance? = instances[instanceId]

  fun getOrPut(instanceId: String, factory: () -> TtsEngineInstance): TtsEngineInstance =
    instances.getOrPut(instanceId, factory)

  fun remove(instanceId: String): TtsEngineInstance? = instances.remove(instanceId)

  fun clear() {
    instances.clear()
  }

  fun forEachInstance(block: (TtsEngineInstance) -> Unit) {
    instances.values.forEach(block)
  }
}
