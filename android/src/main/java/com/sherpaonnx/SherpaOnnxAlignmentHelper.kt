package com.sherpaonnx

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import ai.onnxruntime.TensorInfo
import android.net.Uri
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.k2fsa.sherpa.onnx.WaveReader
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.nio.FloatBuffer
import java.util.Locale
import java.util.concurrent.Executors
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

internal class SherpaOnnxAlignmentHelper(
  private val context: ReactApplicationContext
) {
  private val executor = Executors.newSingleThreadExecutor()

  private data class AlignmentItem(
    val text: String,
    val start: Double,
    val end: Double,
  )

  private data class ExpandedTarget(
    val ids: IntArray,
    val tokenIndices: IntArray,
  )

  fun shutdown() {
    executor.shutdownNow()
  }

  fun runCTCForcedAlignment(
    modelPath: String,
    audioPath: String,
    text: String,
    vocabJson: String,
    promise: Promise,
  ) {
    executor.execute {
      var cleanupPath: String? = null
      try {
        val resolvedAudio = resolveAudioPath(audioPath)
        cleanupPath = resolvedAudio.second

        val file = File(resolvedAudio.first)
        if (!file.exists() || file.length() <= 0L) {
          promise.reject("ALIGNMENT_ERROR", "Audio file does not exist or is empty: ${resolvedAudio.first}")
          return@execute
        }

        val vocab = parseVocab(vocabJson)
        val blankId = vocab["<pad>"] ?: 0
        val wordBoundaryId = vocab["|"] ?: 4

        val tokenTexts = buildTokenTexts(text, vocab, wordBoundaryId)
        if (tokenTexts.isEmpty()) {
          promise.reject("ALIGNMENT_ERROR", "Transcript has no alignable tokens for the provided vocabulary")
          return@execute
        }

        val tokenIds = IntArray(tokenTexts.size) { index ->
          vocab[tokenTexts[index]] ?: blankId
        }

        val wave = WaveReader.readWave(resolvedAudio.first)
        val rawSamples = wave.samples ?: FloatArray(0)
        if (rawSamples.isEmpty()) {
          promise.reject("ALIGNMENT_ERROR", "Could not decode WAV samples from: ${resolvedAudio.first}")
          return@execute
        }

        val mono16k = if (wave.sampleRate == 16000) {
          rawSamples
        } else {
          resampleLinear(rawSamples, wave.sampleRate, 16000)
        }

        val normalized = normalizeAudio(mono16k)
        if (normalized.isEmpty()) {
          promise.reject("ALIGNMENT_ERROR", "Audio is empty after preprocessing")
          return@execute
        }

        val logits = runInference(modelPath, normalized)
        if (logits.isEmpty() || logits[0].isEmpty()) {
          promise.reject("ALIGNMENT_ERROR", "Model inference returned empty logits")
          return@execute
        }

        val expanded = buildExpandedTarget(tokenIds, blankId)
        val path = ctcBacktrack(logits, expanded.ids, blankId)

        val frameIndicesByToken = Array(tokenIds.size) { mutableListOf<Int>() }
        for (t in path.indices) {
          val state = path[t]
          if (state < 0 || state >= expanded.tokenIndices.size) {
            continue
          }
          val tokenIndex = expanded.tokenIndices[state]
          val tokenId = expanded.ids[state]
          if (tokenIndex >= 0 && tokenIndex < frameIndicesByToken.size && tokenId != blankId) {
            frameIndicesByToken[tokenIndex].add(t)
          }
        }

        val charItems = mutableListOf<AlignmentItem>()
        var fallbackEndFrame = 0

        for (i in tokenTexts.indices) {
          val token = tokenTexts[i]
          if (token == "|") {
            continue
          }

          val frames = frameIndicesByToken[i]
          val startFrame: Int
          val endFrameExclusive: Int
          if (frames.isNotEmpty()) {
            startFrame = frames.first()
            endFrameExclusive = frames.last() + 1
            fallbackEndFrame = max(fallbackEndFrame, endFrameExclusive)
          } else {
            startFrame = fallbackEndFrame
            endFrameExclusive = fallbackEndFrame
          }

          val start = startFrame * 0.02
          val end = max(start, endFrameExclusive * 0.02)
          charItems.add(AlignmentItem(token, start, end))
        }

        val wordItems = mutableListOf<AlignmentItem>()
        val currentWord = StringBuilder()
        var wordStart = 0.0
        var wordEnd = 0.0
        var charCursor = 0

        for (token in tokenTexts) {
          if (token == "|") {
            if (currentWord.isNotEmpty()) {
              wordItems.add(AlignmentItem(currentWord.toString(), wordStart, wordEnd))
              currentWord.clear()
            }
            continue
          }

          val charItem = charItems.getOrNull(charCursor)
          charCursor += 1
          if (charItem == null) {
            continue
          }

          if (currentWord.isEmpty()) {
            wordStart = charItem.start
            wordEnd = charItem.end
          } else {
            wordEnd = max(wordEnd, charItem.end)
          }
          currentWord.append(charItem.text)
        }

        if (currentWord.isNotEmpty()) {
          wordItems.add(AlignmentItem(currentWord.toString(), wordStart, wordEnd))
        }

        val result = Arguments.createMap()
        result.putArray("words", toWritableArray(wordItems))
        result.putArray("chars", toWritableArray(charItems))
        promise.resolve(result)
      } catch (e: Exception) {
        Log.e("SherpaOnnxAlignment", "ALIGNMENT_ERROR: ${e.message}", e)
        promise.reject("ALIGNMENT_ERROR", e.message ?: "CTC alignment failed", e)
      } finally {
        if (cleanupPath != null) {
          try {
            File(cleanupPath).delete()
          } catch (_: Exception) {
            // ignore cleanup errors
          }
        }
      }
    }
  }

  private fun resolveAudioPath(audioPath: String): Pair<String, String?> {
    if (!audioPath.startsWith("content://")) {
      return Pair(audioPath, null)
    }

    val uri = Uri.parse(audioPath)
    val tempFile = File.createTempFile("alignment_input_", ".wav", context.cacheDir)
    context.contentResolver.openInputStream(uri)?.use { input ->
      FileOutputStream(tempFile).use { output ->
        input.copyTo(output)
      }
    } ?: throw IllegalStateException("Could not open content URI: $audioPath")

    return Pair(tempFile.absolutePath, tempFile.absolutePath)
  }

  private fun parseVocab(vocabJson: String): Map<String, Int> {
    val obj = JSONObject(vocabJson)
    val out = linkedMapOf<String, Int>()
    val keys = obj.keys()
    while (keys.hasNext()) {
      val key = keys.next()
      if (key.isBlank()) {
        continue
      }
      val value = obj.optInt(key, Int.MIN_VALUE)
      if (value != Int.MIN_VALUE) {
        out[key] = value
      }
    }
    if (out.isEmpty()) {
      throw IllegalArgumentException("Vocabulary JSON is empty")
    }
    return out
  }

  private fun buildTokenTexts(
    text: String,
    vocab: Map<String, Int>,
    wordBoundaryId: Int,
  ): List<String> {
    val out = mutableListOf<String>()
    val uppercase = text.uppercase(Locale.US)

    for (char in uppercase) {
      if (char.isWhitespace()) {
        if (out.isNotEmpty() && out.last() != "|") {
          out.add("|")
        }
        continue
      }

      val normalized = when (char) {
        '’', '`', '´' -> '\''
        else -> char
      }
      val token = normalized.toString()
      if (vocab.containsKey(token)) {
        out.add(token)
      }
    }

    while (out.firstOrNull() == "|") {
      out.removeAt(0)
    }
    while (out.lastOrNull() == "|") {
      out.removeAt(out.lastIndex)
    }

    if (!vocab.containsKey("|") || vocab["|"] != wordBoundaryId) {
      return out.filter { it != "|" }
    }

    return out
  }

  private fun resampleLinear(
    input: FloatArray,
    sourceSampleRate: Int,
    targetSampleRate: Int,
  ): FloatArray {
    if (input.isEmpty() || sourceSampleRate <= 0 || targetSampleRate <= 0) {
      return FloatArray(0)
    }
    if (sourceSampleRate == targetSampleRate) {
      return input
    }

    val outputLength = max(1, floor(input.size.toDouble() * targetSampleRate / sourceSampleRate).toInt())
    val output = FloatArray(outputLength)
    val ratio = sourceSampleRate.toDouble() / targetSampleRate.toDouble()

    for (i in 0 until outputLength) {
      val srcPos = i * ratio
      val leftIndex = floor(srcPos).toInt()
      val rightIndex = min(leftIndex + 1, input.lastIndex)
      val frac = srcPos - leftIndex
      val left = input[min(leftIndex, input.lastIndex)]
      val right = input[rightIndex]
      output[i] = (left + (right - left) * frac).toFloat()
    }

    return output
  }

  private fun normalizeAudio(input: FloatArray): FloatArray {
    if (input.isEmpty()) {
      return input
    }

    var sum = 0.0
    for (sample in input) {
      sum += sample
    }
    val mean = sum / input.size

    var varianceSum = 0.0
    for (sample in input) {
      val centered = sample - mean
      varianceSum += centered * centered
    }

    val std = sqrt(max(varianceSum / input.size, 1e-12))
    val out = FloatArray(input.size)
    for (i in input.indices) {
      out[i] = ((input[i] - mean) / std).toFloat()
    }
    return out
  }

  private fun runInference(modelPath: String, samples: FloatArray): Array<FloatArray> {
    val env = OrtEnvironment.getEnvironment()

    OrtSession.SessionOptions().use { sessionOptions ->
      env.createSession(modelPath, sessionOptions).use { session ->
        val inputName = session.inputNames.firstOrNull()
          ?: throw IllegalStateException("Alignment model has no input")

        val inputShape = longArrayOf(1L, samples.size.toLong())
        OnnxTensor.createTensor(env, FloatBuffer.wrap(samples), inputShape).use { inputTensor ->
          val outputs = session.run(mapOf(inputName to inputTensor))
          outputs.use { result ->
            val outputTensor = result.get(0) as? OnnxTensor
              ?: throw IllegalStateException("Alignment model output is not a tensor")

            val info = outputTensor.info as? TensorInfo
              ?: throw IllegalStateException("Alignment tensor info missing")

            val shape = info.shape
            val floatBuffer = outputTensor.floatBuffer
            floatBuffer.rewind()

            val totalValues = floatBuffer.remaining()
            if (totalValues <= 0) {
              return emptyArray()
            }

            val logitsFlat = FloatArray(totalValues)
            floatBuffer.get(logitsFlat)

            val (frames, vocabSize) = when {
              shape.size >= 3 -> {
                val t = shape[1].toInt()
                val v = shape[2].toInt()
                Pair(max(1, t), max(1, v))
              }
              shape.size == 2 -> {
                val t = shape[0].toInt()
                val v = shape[1].toInt()
                Pair(max(1, t), max(1, v))
              }
              else -> {
                Pair(1, max(1, totalValues))
              }
            }

            val safeFrames = max(1, min(frames, totalValues))
            val safeVocab = max(1, min(vocabSize, totalValues / safeFrames))

            return logSoftmax(logitsFlat, safeFrames, safeVocab)
          }
        }
      }
    }
  }

  private fun logSoftmax(
    logitsFlat: FloatArray,
    frames: Int,
    vocabSize: Int,
  ): Array<FloatArray> {
    val out = Array(frames) { FloatArray(vocabSize) }

    for (t in 0 until frames) {
      val rowOffset = t * vocabSize
      var rowMax = Float.NEGATIVE_INFINITY
      for (v in 0 until vocabSize) {
        val value = logitsFlat[rowOffset + v]
        if (value > rowMax) {
          rowMax = value
        }
      }

      var sumExp = 0.0
      for (v in 0 until vocabSize) {
        sumExp += exp((logitsFlat[rowOffset + v] - rowMax).toDouble())
      }
      val logDenom = rowMax + ln(max(sumExp, 1e-12))

      for (v in 0 until vocabSize) {
        out[t][v] = (logitsFlat[rowOffset + v] - logDenom).toFloat()
      }
    }

    return out
  }

  private fun buildExpandedTarget(tokenIds: IntArray, blankId: Int): ExpandedTarget {
    val stateSize = tokenIds.size * 2 + 1
    val ids = IntArray(stateSize)
    val tokenIndices = IntArray(stateSize) { -1 }

    var s = 0
    ids[s] = blankId
    for (i in tokenIds.indices) {
      s += 1
      ids[s] = tokenIds[i]
      tokenIndices[s] = i

      s += 1
      ids[s] = blankId
    }

    return ExpandedTarget(ids, tokenIndices)
  }

  private fun ctcBacktrack(
    logProbs: Array<FloatArray>,
    expandedTarget: IntArray,
    blankId: Int,
  ): IntArray {
    val timeSteps = logProbs.size
    val states = expandedTarget.size
    if (timeSteps == 0 || states == 0) {
      return IntArray(0)
    }

    val negInf = -1.0e30f
    val trellis = Array(timeSteps) { FloatArray(states) { negInf } }

    trellis[0][0] = safeLogProb(logProbs[0], expandedTarget[0])
    if (states > 1) {
      trellis[0][1] = safeLogProb(logProbs[0], expandedTarget[1])
    }

    for (t in 1 until timeSteps) {
      val row = trellis[t]
      val prev = trellis[t - 1]
      for (s in 0 until states) {
        var best = prev[s]
        if (s > 0) {
          best = max(best, prev[s - 1])
        }
        if (
          s > 1 &&
          expandedTarget[s] != blankId &&
          expandedTarget[s] != expandedTarget[s - 2]
        ) {
          best = max(best, prev[s - 2])
        }

        if (best <= negInf / 2) {
          row[s] = negInf
          continue
        }

        row[s] = best + safeLogProb(logProbs[t], expandedTarget[s])
      }
    }

    var state = if (
      states > 1 &&
      trellis[timeSteps - 1][states - 2] > trellis[timeSteps - 1][states - 1]
    ) {
      states - 2
    } else {
      states - 1
    }

    val path = IntArray(timeSteps)
    path[timeSteps - 1] = state

    for (t in (timeSteps - 1) downTo 1) {
      val prev = trellis[t - 1]
      var bestState = state
      var bestScore = prev[state]

      if (state > 0) {
        val stepScore = prev[state - 1]
        if (stepScore > bestScore) {
          bestScore = stepScore
          bestState = state - 1
        }
      }

      if (
        state > 1 &&
        expandedTarget[state] != blankId &&
        expandedTarget[state] != expandedTarget[state - 2]
      ) {
        val skipScore = prev[state - 2]
        if (skipScore > bestScore) {
          bestState = state - 2
        }
      }

      state = bestState
      path[t - 1] = state
    }

    return path
  }

  private fun safeLogProb(row: FloatArray, tokenId: Int): Float {
    if (tokenId < 0 || tokenId >= row.size) {
      return -1.0e30f
    }
    return row[tokenId]
  }

  private fun toWritableArray(items: List<AlignmentItem>): WritableArray {
    val array = Arguments.createArray()
    for (item in items) {
      val map: WritableMap = Arguments.createMap()
      map.putString("text", item.text)
      map.putDouble("start", item.start)
      map.putDouble("end", item.end)
      array.pushMap(map)
    }
    return array
  }
}
