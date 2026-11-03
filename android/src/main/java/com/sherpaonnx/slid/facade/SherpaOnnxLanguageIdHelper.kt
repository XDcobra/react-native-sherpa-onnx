package com.sherpaonnx.slid.facade

import android.os.SystemClock
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.sherpaonnx.audio.pipeline.PipelineAudioRegistry
import com.sherpaonnx.errors.OfflineOomError
import com.sherpaonnx.lifecycle.NativeInstanceGate
import com.sherpaonnx.segment.pipeline.SegmentPipelineRegistry
import com.sherpaonnx.segment.pipeline.SegmentRecord
import com.sherpaonnx.slid.core.LanguageIdDebug
import com.sherpaonnx.slid.core.LanguageIdErrorCodes
import com.sherpaonnx.slid.core.LanguageIdInstance
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

internal class SherpaOnnxLanguageIdHelper {
  private val executor = Executors.newSingleThreadExecutor()
  private val instances = ConcurrentHashMap<String, LanguageIdInstance>()

  fun shutdown() {
    executor.shutdownNow()
    for ((id, inst) in instances) {
      releaseSlidSafely(inst, where = "shutdown:$id")
    }
    instances.clear()
    nativeShutdownAll()
  }

  private fun releaseSlidSafely(inst: LanguageIdInstance, where: String) {
    val gateKey = inst.gateKey()
    val inFlight = NativeInstanceGate.inFlight(gateKey)
    if (inFlight > 0) {
      LanguageIdDebug.warn(
        "UNLOAD_DURING_COMPUTE where=$where instanceId=${inst.instanceId} " +
          "gateKey=$gateKey inFlight=$inFlight",
      )
    }
    val released = NativeInstanceGate.releaseWhenIdle(gateKey) {
      try {
        nativeUnload(inst.instanceId)
      } catch (e: Exception) {
        LanguageIdDebug.warn(
          "unload.releaseError where=$where instanceId=${inst.instanceId} msg=${e.message}",
        )
      }
    }
    LanguageIdDebug.lifecycle(
      "unload.releaseWhenIdle",
      "where=$where instanceId=${inst.instanceId} gateKey=$gateKey " +
        "nativeReleased=$released inFlightWas=$inFlight",
    )
  }

  fun hasInstance(instanceId: String): Boolean =
    instances.containsKey(instanceId) && nativeHasInstance(instanceId)

  fun getInstance(instanceId: String): LanguageIdInstance? = instances[instanceId]

  /**
   * Compute without acquiring [NativeInstanceGate] — caller must already hold the gate
   * (live pipeline worker).
   */
  internal fun computeForLive(
    instanceId: String,
    samples: FloatArray,
    sampleRate: Int,
  ): String {
    @Suppress("UNCHECKED_CAST")
    val raw = nativeCompute(instanceId, samples, sampleRate) as? HashMap<String, Any>
      ?: throw IllegalStateException("nativeCompute returned null")
    val success = raw["success"] as? Boolean ?: false
    if (!success) {
      val err = raw["error"] as? String ?: "compute failed"
      throw IllegalStateException(err)
    }
    return (raw["lang"] as? String)?.trim().orEmpty()
  }

  fun initializeLanguageId(
    instanceId: String,
    options: ReadableMap,
    promise: Promise
  ) {
    if (instanceId.isBlank()) {
      promise.reject(LanguageIdErrorCodes.INIT_ERROR, "instanceId is required")
      return
    }

    val encoder = if (options.hasKey("encoder")) options.getString("encoder") ?: "" else ""
    val decoder = if (options.hasKey("decoder")) options.getString("decoder") ?: "" else ""

    if (encoder.isBlank()) {
      promise.reject(LanguageIdErrorCodes.INIT_ERROR, "encoder path is required")
      return
    }
    if (decoder.isBlank()) {
      promise.reject(LanguageIdErrorCodes.INIT_ERROR, "decoder path is required")
      return
    }

    val tailPaddings = if (options.hasKey("tailPaddings")) options.getInt("tailPaddings") else -1
    val numThreads = if (options.hasKey("numThreads")) options.getInt("numThreads") else 1
    val provider = if (options.hasKey("provider")) options.getString("provider") ?: "cpu" else "cpu"
    val debug = if (options.hasKey("debug")) options.getBoolean("debug") else false

    executor.execute {
      try {
        instances.remove(instanceId)?.let { old ->
          releaseSlidSafely(old, where = "reinit:$instanceId")
        }

        @Suppress("UNCHECKED_CAST")
        val raw = nativeInitialize(
          instanceId,
          encoder,
          decoder,
          tailPaddings,
          numThreads,
          provider,
          debug,
        ) as? HashMap<String, Any>
        val success = raw?.get("success") as? Boolean ?: false
        if (!success) {
          val err = raw?.get("error") as? String ?: "Failed to initialize SLID"
          promise.reject(LanguageIdErrorCodes.INIT_ERROR, err)
          return@execute
        }

        instances[instanceId] = LanguageIdInstance(instanceId)
        val result = Arguments.createMap()
        result.putBoolean("success", true)
        promise.resolve(result)
      } catch (e: OutOfMemoryError) {
        Log.e(LanguageIdErrorCodes.TAG, "OOM initializing SLID", e)
        promise.reject(
          LanguageIdErrorCodes.OFFLINE_OOM,
          OfflineOomError.message("spoken-language-identification"),
          e
        )
      } catch (e: Exception) {
        Log.e(LanguageIdErrorCodes.TAG, "Failed to initialize SLID", e)
        promise.reject(
          LanguageIdErrorCodes.INIT_ERROR,
          "Failed to initialize SLID: ${e.message}",
          e
        )
      }
    }
  }

  private fun computeLang(
    instanceId: String,
    samples: FloatArray,
    sampleRate: Int,
    where: String,
  ): String {
    val inst = instances[instanceId]
      ?: throw IllegalStateException("SLID instance not found: $instanceId")
    val gateKey = inst.gateKey()
    if (!NativeInstanceGate.beginUse(gateKey)) {
      throw IllegalStateException("SLID instance released: $instanceId")
    }
    val opId = LanguageIdDebug.nextOpId()
    LanguageIdDebug.computeEnter(
      slidIdentity = instanceId.hashCode(),
      where = where,
      opId = opId,
      detail = "instanceId=$instanceId samples=${samples.size} sr=$sampleRate",
    )
    try {
      @Suppress("UNCHECKED_CAST")
      val raw = nativeCompute(instanceId, samples, sampleRate) as? HashMap<String, Any>
        ?: throw IllegalStateException("nativeCompute returned null")
      val success = raw["success"] as? Boolean ?: false
      if (!success) {
        val err = raw["error"] as? String ?: "compute failed"
        throw IllegalStateException(err)
      }
      return (raw["lang"] as? String)?.trim().orEmpty()
    } finally {
      LanguageIdDebug.computeLeave(
        slidIdentity = instanceId.hashCode(),
        where = where,
        opId = opId,
        detail = "instanceId=$instanceId",
      )
      NativeInstanceGate.endUse(gateKey)
    }
  }

  fun identifyLanguageOffline(
    instanceId: String,
    audioBufferId: String,
    startSample: Double?,
    endSample: Double?,
    promise: Promise
  ) {
    if (!hasInstance(instanceId)) {
      promise.reject(LanguageIdErrorCodes.NOT_INITIALIZED, "SLID instance not found: $instanceId")
      return
    }

    val audioEntry = PipelineAudioRegistry.getOffline(audioBufferId)
    if (audioEntry == null) {
      promise.reject(
        LanguageIdErrorCodes.BUFFER_NOT_FOUND,
        "Offline audio buffer not found: $audioBufferId"
      )
      return
    }

    if (audioEntry.numSamples == 0) {
      promise.reject(
        LanguageIdErrorCodes.BUFFER_EMPTY,
        "Offline audio buffer is empty: $audioBufferId"
      )
      return
    }

    val hasStart = startSample != null
    val hasEnd = endSample != null
    if (hasStart != hasEnd) {
      promise.reject(
        LanguageIdErrorCodes.INVALID_ARGUMENT,
        "startSample and endSample must both be provided or both omitted"
      )
      return
    }

    executor.execute {
      try {
        val t0 = SystemClock.uptimeMillis()
        val sampleRate = audioEntry.sampleRate
        val samples: FloatArray
        if (!hasStart) {
          samples = audioEntry.readAllSamples()
        } else {
          val start = kotlin.math.floor(startSample!!).toInt().coerceAtLeast(0)
          val endRaw = kotlin.math.floor(endSample!!).toInt().coerceAtLeast(start)
          val end = endRaw.coerceAtMost(audioEntry.numSamples)
          val frameCount = (end - start).coerceAtLeast(0)
          if (frameCount == 0) {
            val result = Arguments.createMap()
            result.putString("lang", "")
            result.putDouble("audioDuration", 0.0)
            result.putDouble("elapsedMs", 0.0)
            promise.resolve(result)
            return@execute
          }
          samples = audioEntry.readSlice(start, frameCount)
        }
        val audioDuration =
          if (sampleRate > 0) samples.size.toDouble() / sampleRate.toDouble() else 0.0

        val lang = computeLang(instanceId, samples, sampleRate, "offline.identify")
        val elapsedMs = (SystemClock.uptimeMillis() - t0).toDouble()

        val result = Arguments.createMap()
        result.putString("lang", lang)
        result.putDouble("audioDuration", audioDuration)
        result.putDouble("elapsedMs", elapsedMs)
        promise.resolve(result)
      } catch (e: OutOfMemoryError) {
        Log.e(LanguageIdErrorCodes.TAG, "OOM during language identification", e)
        promise.reject(
          LanguageIdErrorCodes.OFFLINE_OOM,
          OfflineOomError.message("spoken-language-identification"),
          e
        )
      } catch (e: Exception) {
        Log.e(LanguageIdErrorCodes.TAG, "Language identification failed", e)
        val msg = e.message.orEmpty()
        if (msg.contains("released") || msg.contains("not found")) {
          promise.reject(LanguageIdErrorCodes.NOT_INITIALIZED, msg, e)
        } else {
          promise.reject(
            LanguageIdErrorCodes.IDENTIFY_FAILED,
            "Language identification failed: ${e.message}",
            e
          )
        }
      }
    }
  }

  fun labelLanguageIdOfflineSegments(
    instanceId: String,
    audioInId: String,
    segmentsInId: String,
    segmentsOutId: String,
    promise: Promise
  ) {
    if (instanceId.isBlank()) {
      promise.reject(LanguageIdErrorCodes.INIT_ERROR, "instanceId is required")
      return
    }
    if (!hasInstance(instanceId)) {
      promise.reject(LanguageIdErrorCodes.NOT_INITIALIZED, "SLID instance not found: $instanceId")
      return
    }

    if (audioInId.isBlank() || !audioInId.startsWith("off_")) {
      promise.reject(
        LanguageIdErrorCodes.INVALID_ARGUMENT,
        "Expected offline audio buffer (off_*), got: $audioInId"
      )
      return
    }
    val audioInEntry = PipelineAudioRegistry.getOffline(audioInId)
    if (audioInEntry == null) {
      promise.reject(
        LanguageIdErrorCodes.BUFFER_NOT_FOUND,
        "Offline audio buffer not found: $audioInId"
      )
      return
    }
    if (audioInEntry.numSamples <= 0 || audioInEntry.sampleRate <= 0) {
      promise.reject(
        LanguageIdErrorCodes.BUFFER_EMPTY,
        "Offline audio buffer is empty: $audioInId"
      )
      return
    }

    if (segmentsInId.isBlank() || !segmentsInId.startsWith("seg_off_")) {
      promise.reject(
        LanguageIdErrorCodes.INVALID_ARGUMENT,
        "Expected offline segment buffer (seg_off_*) for segmentsIn, got: $segmentsInId"
      )
      return
    }
    val segmentsInEntry = SegmentPipelineRegistry.getOffline(segmentsInId)
    if (segmentsInEntry == null) {
      promise.reject(
        LanguageIdErrorCodes.BUFFER_NOT_FOUND,
        "Offline segment buffer not found: $segmentsInId"
      )
      return
    }

    if (segmentsOutId.isBlank() || !segmentsOutId.startsWith("seg_off_")) {
      promise.reject(
        LanguageIdErrorCodes.INVALID_ARGUMENT,
        "Expected offline segment buffer (seg_off_*) for segmentsOut, got: $segmentsOutId"
      )
      return
    }
    val segmentsOutEntry = SegmentPipelineRegistry.getOffline(segmentsOutId)
    if (segmentsOutEntry == null) {
      promise.reject(
        LanguageIdErrorCodes.BUFFER_NOT_FOUND,
        "Offline segment buffer not found: $segmentsOutId"
      )
      return
    }
    if (segmentsOutEntry.snapshotSegments().isNotEmpty()) {
      promise.reject(
        LanguageIdErrorCodes.INVALID_ARGUMENT,
        "segmentsOut must be an empty offline segment buffer: $segmentsOutId"
      )
      return
    }

    executor.execute {
      try {
        val sampleRate = audioInEntry.sampleRate
        val allSegments = segmentsInEntry.snapshotSegments()
        val speechSpans = allSegments.filter { it.kind == "speech" && it.endSample > it.startSample }

        if (speechSpans.isEmpty()) {
          segmentsOutEntry.populate(emptyList())
          val emptyResult = Arguments.createMap()
          emptyResult.putInt("labeledCount", 0)
          emptyResult.putString("dominantLanguage", "")
          emptyResult.putMap("distribution", Arguments.createMap())
          emptyResult.putArray("switches", Arguments.createArray())
          emptyResult.putArray("segments", Arguments.createArray())
          promise.resolve(emptyResult)
          return@execute
        }

        val records = ArrayList<SegmentRecord>(speechSpans.size)
        val segmentsArray = Arguments.createArray()
        val switchesArray = Arguments.createArray()
        val durationByLang = HashMap<String, Double>()
        var totalSpeechDurationMs = 0.0
        var previousLang: String? = null

        for (i in speechSpans.indices) {
          val span = speechSpans[i]
          val frameCount = (span.endSample - span.startSample).coerceAtLeast(0)
          val samples = audioInEntry.readSlice(span.startSample, frameCount)
          val lang = computeLang(instanceId, samples, sampleRate, "offline.label")

          val durationMs = if (span.durationMs > 0) span.durationMs else {
            if (sampleRate > 0) ((span.endSample - span.startSample) * 1000) / sampleRate else 0
          }
          val startTime =
            if (sampleRate > 0) span.startSample.toDouble() / sampleRate.toDouble() else 0.0
          val endTime =
            if (sampleRate > 0) span.endSample.toDouble() / sampleRate.toDouble() else 0.0

          records.add(
            SegmentRecord(
              id = span.id,
              kind = "speech",
              sourceAudioBufferId = audioInId,
              startSample = span.startSample,
              endSample = span.endSample,
              sampleRate = span.sampleRate,
              durationMs = durationMs,
              confidence = span.confidence,
              payloadJson = "{\"source\":\"languageId\",\"lang\":\"$lang\"}"
            )
          )

          val segMap = Arguments.createMap()
          segMap.putInt("segmentIndex", i)
          segMap.putDouble("startTime", startTime)
          segMap.putDouble("endTime", endTime)
          segMap.putInt("durationMs", durationMs)
          segMap.putString("lang", lang)
          segmentsArray.pushMap(segMap)

          if (lang.isNotEmpty()) {
            val dur = durationMs.toDouble()
            durationByLang[lang] = (durationByLang[lang] ?: 0.0) + dur
            totalSpeechDurationMs += dur

            if (previousLang == null || lang != previousLang) {
              val switchMap = Arguments.createMap()
              switchMap.putDouble("timestamp", startTime)
              if (previousLang == null) {
                switchMap.putNull("from")
              } else {
                switchMap.putString("from", previousLang)
              }
              switchMap.putString("to", lang)
              switchMap.putInt("segmentIndex", i)
              switchesArray.pushMap(switchMap)
              previousLang = lang
            }
          }
        }

        segmentsOutEntry.populate(records)

        var dominantLanguage = ""
        var maxDuration = -1.0
        val distMap = Arguments.createMap()
        if (totalSpeechDurationMs > 0) {
          for ((l, dur) in durationByLang) {
            if (dur > maxDuration) {
              maxDuration = dur
              dominantLanguage = l
            }
            val fraction = Math.round((dur / totalSpeechDurationMs) * 10000.0) / 10000.0
            distMap.putDouble(l, fraction)
          }
        }

        val result = Arguments.createMap()
        result.putInt("labeledCount", records.size)
        result.putString("dominantLanguage", dominantLanguage)
        result.putMap("distribution", distMap)
        result.putArray("switches", switchesArray)
        result.putArray("segments", segmentsArray)
        promise.resolve(result)
      } catch (e: OutOfMemoryError) {
        Log.e(LanguageIdErrorCodes.TAG, "OOM during language identification labeling", e)
        promise.reject(
          LanguageIdErrorCodes.OFFLINE_OOM,
          OfflineOomError.message("spoken-language-identification"),
          e
        )
      } catch (e: Exception) {
        Log.e(LanguageIdErrorCodes.TAG, "Language identification labeling failed", e)
        val msg = e.message.orEmpty()
        if (msg.contains("released") || msg.contains("not found")) {
          promise.reject(LanguageIdErrorCodes.NOT_INITIALIZED, msg, e)
        } else {
          promise.reject(
            LanguageIdErrorCodes.IDENTIFY_FAILED,
            "Language identification labeling failed: ${e.message}",
            e
          )
        }
      }
    }
  }

  fun unloadLanguageId(
    instanceId: String,
    promise: Promise
  ) {
    executor.execute {
      try {
        val inst = instances.remove(instanceId)
        if (inst != null) {
          LanguageIdDebug.lifecycle(
            "unload.begin",
            "instanceId=$instanceId inFlight=${NativeInstanceGate.inFlight(inst.gateKey())}",
          )
          releaseSlidSafely(inst, where = "unload:$instanceId")
          LanguageIdDebug.lifecycle("unload.done", "instanceId=$instanceId")
        } else {
          // Ensure JNI map is cleared even if Kotlin bookkeeping missed it.
          nativeUnload(instanceId)
          LanguageIdDebug.lifecycle("unload.miss", "instanceId=$instanceId")
        }
        promise.resolve(null)
      } catch (e: Exception) {
        Log.w(LanguageIdErrorCodes.TAG, "Error unloading SLID instance: ${e.message}", e)
        promise.resolve(null)
      }
    }
  }

  companion object {
    @JvmStatic
    private external fun nativeInitialize(
      instanceId: String,
      encoder: String,
      decoder: String,
      tailPaddings: Int,
      numThreads: Int,
      provider: String,
      debug: Boolean,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeCompute(
      instanceId: String,
      samples: FloatArray,
      sampleRate: Int,
    ): HashMap<String, Any>?

    @JvmStatic
    private external fun nativeHasInstance(instanceId: String): Boolean

    @JvmStatic
    private external fun nativeUnload(instanceId: String)

    @JvmStatic
    private external fun nativeShutdownAll()
  }
}
