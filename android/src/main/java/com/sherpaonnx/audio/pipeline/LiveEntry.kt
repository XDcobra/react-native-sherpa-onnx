package com.sherpaonnx.audio.pipeline

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicReference

/**
 * Thin handle over shared C++ PaLiveEntry (no Kotlin ring/spool SoT).
 * Event coalescing and listener fan-out stay in Kotlin; PCM lives in C++.
 */
class LiveEntry(
  val bufferId: String,
  val sampleRate: Int,
  val channelCount: Int = 1,
  windowSeconds: Double = 8.0,
  persistence: PersistenceConfig? = null,
  appendEventConfig: LiveAppendEventConfig = LiveAppendEventConfig(),
  onFramesAppended: ((LiveFramesAppendedEvent) -> Unit)? = null,
  isTemporarySpool: Boolean = false,
) {
  enum class AppendResult {
    APPENDED,
    BUFFER_FINALIZED,
  }

  enum class State { RECORDING, FINISHED }

  val kind: String = "livePcmBuffer"

  private val windowCapacity: Int =
    (windowSeconds * sampleRate).toInt().coerceAtLeast(sampleRate)

  @Suppress("UNUSED_PARAMETER")
  private val persistenceUnused = persistence

  var isTemporarySpool: Boolean = isTemporarySpool
    private set
  @Volatile
  private var appendEventsEnabled: Boolean = appendEventConfig.enabled

  @Volatile
  private var appendEventsMinIntervalMs: Int = appendEventConfig.minIntervalMs.coerceAtLeast(0)

  private val onFramesAppendedListener = AtomicReference(onFramesAppended)
  private val appendListeners = CopyOnWriteArrayList<(LiveFramesAppendedEvent) -> Unit>()

  private val pendingLock = Any()
  private var pendingFrameCount: Int = 0
  private var pendingOrigin: LiveAppendOrigin? = null
  private var pendingOriginsMixed: Boolean = false
  private var lastFlushMs: Long = 0L

  val state: State
    get() =
      if (AudioBufferNative.nativeLiveState(bufferId) == 1) State.FINISHED else State.RECORDING

  val totalSamplesWritten: Long
    get() = AudioBufferNative.nativeLiveTotalSamples(bufferId).coerceAtLeast(0)

  val numSamples: Long
    get() = totalSamplesWritten

  val hasActiveSpool: Boolean
    get() = AudioBufferNative.nativeLiveHasActiveSpool(bufferId)

  val spoolPath: String?
    get() = AudioBufferNative.nativeLiveSpoolPath(bufferId)

  val spoolFilePath: String?
    get() = spoolPath

  fun toWritableMap(): WritableMap {
    val map = Arguments.createMap()
    map.putString("bufferId", bufferId)
    map.putString("kind", "livePcmBuffer")
    map.putString("state", if (state == State.FINISHED) "finished" else "recording")
    map.putInt("sampleRate", sampleRate)
    map.putInt("channelCount", channelCount)
    map.putDouble("numSamples", numSamples.toDouble())
    map.putDouble(
      "durationMs",
      if (sampleRate > 0) (numSamples.toDouble() / sampleRate) * 1000.0 else 0.0,
    )
    map.putDouble("totalSamplesWritten", totalSamplesWritten.toDouble())
    map.putBoolean("hasActiveSpool", hasActiveSpool)
    return map
  }

  fun tryAppendSamples(
    samples: FloatArray,
    inputSampleRate: Int = sampleRate,
    origin: LiveAppendOrigin = LiveAppendOrigin.Ingress(LiveAudioIngressSource.APPEND),
    backpressure: Boolean = false,
  ): AppendResult {
    @Suppress("UNUSED_VARIABLE")
    val unusedBp = backpressure
    if (state != State.RECORDING) return AppendResult.BUFFER_FINALIZED
    val ok = AudioBufferNative.nativeAppendSamplesToLive(bufferId, samples, inputSampleRate)
    if (!ok) {
      return if (state != State.RECORDING) AppendResult.BUFFER_FINALIZED else AppendResult.BUFFER_FINALIZED
    }
    dispatchFramesAppended(samples.size, origin)
    return AppendResult.APPENDED
  }

  /** Append Int16 PCM without a Kotlin FloatArray convert (C ÷32768). */
  fun tryAppendInt16Samples(
    samples: ShortArray,
    inputSampleRate: Int = sampleRate,
    origin: LiveAppendOrigin = LiveAppendOrigin.Ingress(LiveAudioIngressSource.APPEND),
    backpressure: Boolean = false,
  ): AppendResult {
    @Suppress("UNUSED_VARIABLE")
    val unusedBp = backpressure
    if (state != State.RECORDING) return AppendResult.BUFFER_FINALIZED
    if (samples.isEmpty()) return AppendResult.APPENDED
    val ok = AudioBufferNative.nativeAppendInt16SamplesToLive(bufferId, samples, inputSampleRate)
    if (!ok) {
      return AppendResult.BUFFER_FINALIZED
    }
    dispatchFramesAppended(samples.size, origin)
    return AppendResult.APPENDED
  }

  fun appendSamples(
    samples: FloatArray,
    inputSampleRate: Int = sampleRate,
    origin: LiveAppendOrigin = LiveAppendOrigin.Ingress(LiveAudioIngressSource.APPEND),
    blockIfFull: Boolean = false,
  ) {
    val result = tryAppendSamples(samples, inputSampleRate, origin, blockIfFull)
    check(result == AppendResult.APPENDED) { "Cannot append to finalized LiveBuffer" }
  }

  fun enableSpool(config: PersistenceConfig, temporary: Boolean = false) {
    check(state == State.RECORDING) { "Cannot enable spool on finalized buffer" }
    AudioBufferNative.nativeEnableSpool(bufferId, config.filePath, temporary)
    isTemporarySpool = temporary
  }

  fun configureAppendEvents(enabled: Boolean? = null, minIntervalMs: Int? = null) {
    if (enabled != null) appendEventsEnabled = enabled
    if (minIntervalMs != null) appendEventsMinIntervalMs = minIntervalMs.coerceAtLeast(0)
  }

  fun setOnFramesAppendedListener(listener: ((LiveFramesAppendedEvent) -> Unit)?) {
    onFramesAppendedListener.set(listener)
  }

  fun addAppendListener(listener: (LiveFramesAppendedEvent) -> Unit) {
    appendListeners.add(listener)
  }

  fun removeAppendListener(listener: (LiveFramesAppendedEvent) -> Unit) {
    appendListeners.remove(listener)
  }

  fun flushFramesAppendedEvents() {
    flushPendingFramesAppendedEvent()
  }

  fun finalize_() {
    flushPendingFramesAppendedEvent()
    AudioBufferNative.nativeFinalizeLive(bufferId)
  }

  fun finalizeRecording() = finalize_()

  fun snapshotRing(): FloatArray {
    val total = totalSamplesWritten.toInt().coerceAtLeast(0)
    if (total == 0) return FloatArray(0)
    // Cap materialize to a reasonable window; C ring may be smaller.
    val max = minOf(total, sampleRate * 120)
    return AudioBufferNative.nativeReadLiveSlice(bufferId, 0, max) ?: FloatArray(0)
  }

  fun getSamplesSlice(startFrame: Int, frameCount: Int): FloatArray =
    AudioBufferNative.nativeReadLiveSlice(bufferId, startFrame, frameCount) ?: FloatArray(0)

  fun detachSpoolForTransfer() {
    // C transfer owns spool detach; mirror flag for Kotlin callers.
  }

  fun createCursorHandle(): Int = AudioBufferNative.nativeCreateCursor(bufferId)

  fun drainCursor(cursorId: Int, maxSamples: Int): FloatArray =
    AudioBufferNative.nativeDrainCursor(bufferId, cursorId, maxSamples) ?: FloatArray(0)

  /** Drain into [out] at [outOffset]; returns samples written (no new FloatArray). */
  fun drainCursorInto(
    cursorId: Int,
    out: FloatArray,
    outOffset: Int,
    maxSamples: Int,
  ): Int {
    if (maxSamples <= 0 || outOffset < 0 || outOffset >= out.size) return 0
    return AudioBufferNative.nativeDrainCursorInto(
      bufferId,
      cursorId,
      out,
      outOffset,
      maxSamples,
    )
  }

  fun peekCursor(cursorId: Int, maxSamples: Int): FloatArray =
    AudioBufferNative.nativePeekCursor(bufferId, cursorId, maxSamples) ?: FloatArray(0)

  fun releaseCursor(cursorId: Int) {
    AudioBufferNative.nativeReleaseCursor(bufferId, cursorId)
  }

  fun seekCursor(cursorId: Int, absolutePos: Long) {
    AudioBufferNative.nativeSeekCursor(bufferId, cursorId, absolutePos)
  }

  fun oldestAvailablePos(): Long =
    if (totalSamplesWritten > windowCapacity) totalSamplesWritten - windowCapacity else 0L

  fun activeCursorCount(): Int = AudioBufferNative.nativeLiveActiveCursorCount(bufferId)

  data class DebugIndexSnapshot(
    val bufferId: String,
    val state: State,
    val written: Long,
    val capacity: Int,
    val oldestInRing: Long,
    val used: Int,
    val hasSpool: Boolean,
  ) {
    override fun toString(): String =
      "bufferId=$bufferId state=$state written=$written capacity=$capacity " +
        "oldestInRing=$oldestInRing used=$used hasSpool=$hasSpool"
  }

  fun debugIndexSnapshot(): DebugIndexSnapshot {
    val written = totalSamplesWritten
    val capacity = windowCapacity
    val oldestInRing = if (written > capacity) written - capacity else 0L
    val used = minOf(written, capacity.toLong()).toInt()
    return DebugIndexSnapshot(
      bufferId = bufferId,
      state = state,
      written = written,
      capacity = capacity,
      oldestInRing = oldestInRing,
      used = used,
      hasSpool = hasActiveSpool,
    )
  }

  fun releaseResources() {
    flushPendingFramesAppendedEvent()
    AudioBufferNative.nativeRelease(bufferId)
  }

  private fun dispatchFramesAppended(appendedCount: Int, origin: LiveAppendOrigin) {
    if (!appendEventsEnabled && appendListeners.isEmpty() && onFramesAppendedListener.get() == null) {
      return
    }
    synchronized(pendingLock) {
      if (pendingFrameCount == 0) {
        pendingOrigin = origin
        pendingOriginsMixed = false
      } else if (pendingOrigin != null && pendingOrigin != origin) {
        pendingOriginsMixed = true
      }
      pendingFrameCount += appendedCount
    }
    val now = System.currentTimeMillis()
    val interval = appendEventsMinIntervalMs
    if (interval <= 0 || now - lastFlushMs >= interval) {
      flushPendingFramesAppendedEvent()
    }
  }

  private fun flushPendingFramesAppendedEvent() {
    val event: LiveFramesAppendedEvent?
    synchronized(pendingLock) {
      if (pendingFrameCount <= 0) return
      event =
        if (pendingOriginsMixed || pendingOrigin == null) {
          LiveFramesAppendedEvent.mixed(
            liveBufferId = bufferId,
            sampleRate = sampleRate,
            frameCount = pendingFrameCount,
            totalSamplesWritten = totalSamplesWritten,
          )
        } else {
          LiveFramesAppendedEvent.fromOrigin(
            liveBufferId = bufferId,
            origin = pendingOrigin!!,
            sampleRate = sampleRate,
            frameCount = pendingFrameCount,
            totalSamplesWritten = totalSamplesWritten,
          )
        }
      pendingFrameCount = 0
      pendingOrigin = null
      pendingOriginsMixed = false
      lastFlushMs = System.currentTimeMillis()
    }
    if (event != null) {
      onFramesAppendedListener.get()?.invoke(event)
      for (listener in appendListeners) {
        listener.invoke(event)
      }
    }
  }

  companion object {
    fun wrap(bufferId: String): LiveEntry? {
      if (!AudioBufferNative.nativeIsLive(bufferId)) return null
      val sr = AudioBufferNative.nativeLiveSampleRate(bufferId)
      if (sr <= 0) return null
      return LiveEntry(bufferId, sr, 1)
    }
  }
}
