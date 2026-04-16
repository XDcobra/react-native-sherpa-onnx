package com.sherpaonnx.audio.pipeline

import android.app.ActivityManager
import android.content.Context
import android.util.Log

internal enum class DeviceRamClass {
  LOW,
  MID,
  HIGH,
  VERY_HIGH,
}

internal enum class ThresholdPathType {
  FILE_ORIGIN,
  HEAP_ORIGIN,
}

private data class MmapThresholdSnapshot(
  val ramClass: DeviceRamClass,
  val fileOriginThresholdBytes: Long,
  val heapOriginThresholdBytes: Long,
)

internal object MmapThresholdPolicy {
  private const val TAG = "MmapThresholdPolicy"

  private const val MB = 1024L * 1024L
  private const val MIN_THRESHOLD_BYTES = 4L * MB
  private const val MAX_THRESHOLD_BYTES = 32L * MB

  private const val LOW_RAM_MAX_BYTES = 3L * 1024L * 1024L * 1024L
  private const val MID_RAM_MAX_BYTES = 6L * 1024L * 1024L * 1024L
  private const val HIGH_RAM_MAX_BYTES = 12L * 1024L * 1024L * 1024L

  private const val ANDROID_FILE_ORIGIN_BASE_MB = 6.0
  private const val ANDROID_HEAP_ORIGIN_BASE_MB = 10.0

  private const val MULTIPLIER_LOW = 0.75
  private const val MULTIPLIER_MID = 1.0
  private const val MULTIPLIER_HIGH = 1.5
  private const val MULTIPLIER_VERY_HIGH = 2.0

  private val lock = Any()

  @Volatile
  private var snapshot: MmapThresholdSnapshot? = null

  @Volatile
  private var logged = false

  fun initialize(context: Context) {
    if (snapshot != null) {
      logPolicyOnce()
      return
    }
    synchronized(lock) {
      if (snapshot == null) {
        val ramClass = detectRamClass(context.applicationContext)
        snapshot = createSnapshot(ramClass)
      }
    }
    logPolicyOnce()
  }

  fun thresholdBytes(pathType: ThresholdPathType): Long {
    val s = ensureSnapshot()
    logPolicyOnce()
    return when (pathType) {
      ThresholdPathType.FILE_ORIGIN -> s.fileOriginThresholdBytes
      ThresholdPathType.HEAP_ORIGIN -> s.heapOriginThresholdBytes
    }
  }

  private fun ensureSnapshot(): MmapThresholdSnapshot {
    snapshot?.let { return it }
    synchronized(lock) {
      snapshot?.let { return it }
      // Fallback if initialize() has not run yet.
      // Do not cache it, so initialize(context) can still detect and persist real RAM class.
      return createSnapshot(DeviceRamClass.MID)
    }
  }

  private fun detectRamClass(context: Context): DeviceRamClass {
    return try {
      val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
        ?: return DeviceRamClass.MID
      val info = ActivityManager.MemoryInfo()
      am.getMemoryInfo(info)
      classifyRam(info.totalMem)
    } catch (_: Exception) {
      DeviceRamClass.MID
    }
  }

  private fun classifyRam(totalMemBytes: Long): DeviceRamClass {
    return when {
      totalMemBytes <= LOW_RAM_MAX_BYTES -> DeviceRamClass.LOW
      totalMemBytes <= MID_RAM_MAX_BYTES -> DeviceRamClass.MID
      totalMemBytes <= HIGH_RAM_MAX_BYTES -> DeviceRamClass.HIGH
      else -> DeviceRamClass.VERY_HIGH
    }
  }

  private fun createSnapshot(ramClass: DeviceRamClass): MmapThresholdSnapshot {
    val multiplier = when (ramClass) {
      DeviceRamClass.LOW -> MULTIPLIER_LOW
      DeviceRamClass.MID -> MULTIPLIER_MID
      DeviceRamClass.HIGH -> MULTIPLIER_HIGH
      DeviceRamClass.VERY_HIGH -> MULTIPLIER_VERY_HIGH
    }

    val fileThreshold = clampThreshold((ANDROID_FILE_ORIGIN_BASE_MB * multiplier * MB).toLong())
    val heapThreshold = clampThreshold((ANDROID_HEAP_ORIGIN_BASE_MB * multiplier * MB).toLong())

    return MmapThresholdSnapshot(
      ramClass = ramClass,
      fileOriginThresholdBytes = fileThreshold,
      heapOriginThresholdBytes = heapThreshold,
    )
  }

  private fun clampThreshold(bytes: Long): Long {
    return bytes.coerceIn(MIN_THRESHOLD_BYTES, MAX_THRESHOLD_BYTES)
  }

  private fun logPolicyOnce() {
    if (logged) return
    val s = ensureSnapshot()
    synchronized(lock) {
      if (logged) return
      Log.i(
        TAG,
        "mmap threshold policy: platform=android ramClass=${s.ramClass} fileOrigin=${s.fileOriginThresholdBytes} heapOrigin=${s.heapOriginThresholdBytes}"
      )
      logged = true
    }
  }
}
