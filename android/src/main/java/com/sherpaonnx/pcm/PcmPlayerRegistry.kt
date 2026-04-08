package com.sherpaonnx.pcm

import java.util.concurrent.ConcurrentHashMap

internal class PcmPlayerRegistry {
  private val sessions = ConcurrentHashMap<String, PcmPlayerSession>()

  operator fun get(playerId: String): PcmPlayerSession? = sessions[playerId]

  fun put(session: PcmPlayerSession) { sessions[session.playerId] = session }

  fun remove(playerId: String): PcmPlayerSession? = sessions.remove(playerId)

  /** Find player bound to a TTS instance (for playback:true lookup). */
  fun findByTtsInstanceId(ttsInstanceId: String): PcmPlayerSession? =
    sessions.values.firstOrNull { it.ttsInstanceId == ttsInstanceId && !it.destroyed }

  fun destroyAll() {
    sessions.values.forEach { it.destroy() }
    sessions.clear()
  }
}
