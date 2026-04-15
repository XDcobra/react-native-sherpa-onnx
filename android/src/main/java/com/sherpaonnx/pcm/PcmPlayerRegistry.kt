package com.sherpaonnx.pcm

import java.util.concurrent.ConcurrentHashMap

internal class PcmPlayerRegistry {
  private val sessions = ConcurrentHashMap<String, PcmPlayerSession>()

  operator fun get(playerId: String): PcmPlayerSession? = sessions[playerId]

  fun put(session: PcmPlayerSession) { sessions[session.playerId] = session }

  fun remove(playerId: String): PcmPlayerSession? = sessions.remove(playerId)

  fun snapshotSessions(): List<PcmPlayerSession> = sessions.values.toList()

  fun destroyAll() {
    sessions.values.forEach { it.destroy() }
    sessions.clear()
  }
}
