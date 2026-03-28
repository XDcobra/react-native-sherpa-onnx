package com.sherpaonnx

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Android-only progress notification for archive extraction (mirrors background download visibility).
 * Safe no-ops if posting fails (e.g. POST_NOTIFICATIONS denied).
 */
class SherpaOnnxExtractionNotificationHelper private constructor(
  private val context: Context,
  private val notificationId: Int,
  private val title: String,
  private val baseText: String,
) {
  private val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
  @Volatile private var lastBucket: Int = -1

  companion object {
    private const val TAG = "SherpaOnnxExtractNotif"
    const val CHANNEL_ID = "sherpa_onnx_extraction"
    private val nextNotificationId = java.util.concurrent.atomic.AtomicInteger(9_200_000)

    private const val DEFAULT_TITLE = "Model extraction"
    private const val DEFAULT_TEXT = "Extracting archive…"

    fun maybeCreate(
      context: Context,
      showNotificationsEnabled: Boolean?,
      titleOverride: String?,
      textOverride: String?,
    ): SherpaOnnxExtractionNotificationHelper? {
      if (showNotificationsEnabled == false) return null
      val title = titleOverride?.trim()?.takeIf { it.isNotEmpty() } ?: DEFAULT_TITLE
      val text = textOverride?.trim()?.takeIf { it.isNotEmpty() } ?: DEFAULT_TEXT
      val id = nextNotificationId.getAndIncrement()
      return SherpaOnnxExtractionNotificationHelper(context.applicationContext, id, title, text)
    }

    fun ensureChannel(ctx: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val existing = nm.getNotificationChannel(CHANNEL_ID)
      if (existing != null) return
      val ch = NotificationChannel(
        CHANNEL_ID,
        "Model extraction",
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        setShowBadge(false)
      }
      nm.createNotificationChannel(ch)
    }
  }

  private fun buildProgress(percentInt: Int): NotificationCompat.Builder {
    val p = percentInt.coerceIn(0, 100)
    val line = "$baseText $p%"
    return NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle(title)
      .setContentText(line)
      .setStyle(NotificationCompat.BigTextStyle().bigText(line))
      .setOnlyAlertOnce(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setOngoing(true)
      .setProgress(100, p, false)
  }

  fun start() {
    try {
      ensureChannel(context)
      nm.notify(notificationId, buildProgress(0).build())
    } catch (e: Exception) {
      Log.w(TAG, "start: ${e.message}")
    }
  }

  fun updateProgress(percent: Double) {
    val p = percent.toInt().coerceIn(0, 100)
    val bucket = p / 4
    if (bucket == lastBucket && p != 0 && p != 100) return
    lastBucket = bucket
    try {
      nm.notify(notificationId, buildProgress(p).build())
    } catch (e: Exception) {
      Log.w(TAG, "updateProgress: ${e.message}")
    }
  }

  fun finish() {
    try {
      nm.cancel(notificationId)
    } catch (e: Exception) {
      Log.w(TAG, "finish: ${e.message}")
    }
  }
}
