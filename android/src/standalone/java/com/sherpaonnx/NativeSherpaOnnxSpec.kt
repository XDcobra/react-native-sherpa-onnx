// Stub for standalone AAR build only. When building inside a React Native app,
// codegen generates this spec; here we provide an abstract base so the same Kotlin sources compile.
package com.sherpaonnx

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReactContextBaseJavaModule

abstract class NativeSherpaOnnxSpec(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  abstract fun testSherpaInit(promise: Promise)
  abstract fun resolveModelPath(config: ReadableMap, promise: Promise)
  abstract fun extractTarBz2(sourcePath: String, targetPath: String, force: Boolean, promise: Promise)
  abstract fun cancelExtractTarBz2(promise: Promise)
  abstract fun computeFileSha256(filePath: String, promise: Promise)
  abstract fun initializeSherpaOnnx(
    modelDir: String,
    preferInt8: Boolean?,
    modelType: String?,
    debug: Boolean?,
    promise: Promise
  )
  abstract fun unloadSherpaOnnx(promise: Promise)
  abstract fun transcribeFile(filePath: String, promise: Promise)
  abstract fun convertAudioToFormat(
    inputPath: String,
    outputPath: String,
    format: String,
    outputSampleRateHz: Double?,
    promise: Promise
  )
  abstract fun convertAudioToWav16k(inputPath: String, outputPath: String, promise: Promise)
  abstract fun initializeTts(
    modelDir: String,
    modelType: String,
    numThreads: Double,
    debug: Boolean,
    noiseScale: Double?,
    noiseScaleW: Double?,
    lengthScale: Double?,
    promise: Promise
  )
  abstract fun updateTtsParams(
    noiseScale: Double?,
    noiseScaleW: Double?,
    lengthScale: Double?,
    promise: Promise
  )
  abstract fun generateTts(text: String, sid: Double, speed: Double, promise: Promise)
  abstract fun generateTtsWithTimestamps(
    text: String,
    sid: Double,
    speed: Double,
    promise: Promise
  )
  abstract fun generateTtsStream(text: String, sid: Double, speed: Double, promise: Promise)
  abstract fun cancelTtsStream(promise: Promise)
  abstract fun startTtsPcmPlayer(sampleRate: Double, channels: Double, promise: Promise)
  abstract fun writeTtsPcmChunk(samples: ReadableArray, promise: Promise)
  abstract fun stopTtsPcmPlayer(promise: Promise)
  abstract fun getTtsSampleRate(promise: Promise)
  abstract fun getTtsNumSpeakers(promise: Promise)
  abstract fun unloadTts(promise: Promise)
  abstract fun saveTtsAudioToFile(
    samples: ReadableArray,
    sampleRate: Double,
    filePath: String,
    promise: Promise
  )
  abstract fun saveTtsAudioToContentUri(
    samples: ReadableArray,
    sampleRate: Double,
    directoryUri: String,
    filename: String,
    promise: Promise
  )
  abstract fun saveTtsTextToContentUri(
    text: String,
    directoryUri: String,
    filename: String,
    mimeType: String,
    promise: Promise
  )
  abstract fun copyTtsContentUriToCache(fileUri: String, filename: String, promise: Promise)
  abstract fun shareTtsAudio(fileUri: String, mimeType: String, promise: Promise)
  abstract fun listAssetModels(promise: Promise)
  abstract fun listModelsAtPath(path: String, recursive: Boolean, promise: Promise)
  abstract fun getAssetPackPath(packName: String, promise: Promise)
}
