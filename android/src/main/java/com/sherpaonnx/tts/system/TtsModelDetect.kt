package com.sherpaonnx.tts.system

import com.sherpaonnx.SherpaOnnxModule
import com.sherpaonnx.SherpaOnnxNativeLoader

/**
 * Typed, blocking TTS model detect for Android system TTS ([SherpaOnnxTextToSpeechService]).
 *
 * Native detection already lives in JNI (`nativeDetectTtsModel`) and is exposed to React Native via
 * [com.sherpaonnx.SherpaOnnxModule.detectTtsModel] (Promise) and internally via
 * [com.sherpaonnx.tts.service.TtsInitializationService] (injected `HashMap` callback). Those paths
 * assume an initialized RN module / TTS coordinator lifecycle.
 *
 * A system [android.speech.tts.TextToSpeechService] runs in a separate process thread with no React
 * context. It needs the same detect result (paths, model type, language rows) synchronously when
 * building [SystemTtsConfig]. This file is therefore a small Kotlin-only adapter:
 * [SherpaOnnxNativeLoader.ensureLoaded] → [SherpaOnnxModule.detectTtsModelBlocking] → parsed
 * [TtsModelDetectResult]. It does not reimplement detection; it only bridges the existing native
 * API to typed system-TTS consumers.
 */

/** Parsed `{ iso6391Hint, id }` row from native TTS detect. */
data class PublicLanguageRow(
  val iso6391Hint: String,
  val id: String,
)

/** Result of blocking TTS model detection for system services (no React bridge). */
data class TtsModelDetectResult(
  val success: Boolean,
  val modelType: String?,
  val paths: Map<String, String>,
  val languageRows: List<PublicLanguageRow>,
  val error: String?,
)

/** Entry point for [detect]; see file-level KDoc above. */
object TtsModelDetect {
  fun detect(
    modelDir: String,
    assetName: String? = null,
    modelType: String = "auto",
  ): TtsModelDetectResult {
    SherpaOnnxNativeLoader.ensureLoaded()
    @Suppress("UNCHECKED_CAST")
    val raw =
      SherpaOnnxModule.detectTtsModelBlocking(modelDir, assetName, modelType)
        as? HashMap<String, Any?>
    if (raw == null) {
      return TtsModelDetectResult(
        success = false,
        modelType = null,
        paths = emptyMap(),
        languageRows = emptyList(),
        error = "TTS model detection returned null",
      )
    }
    val success = raw["success"] as? Boolean ?: false
    val modelTypeStr = raw["modelType"] as? String
    @Suppress("UNCHECKED_CAST")
    val pathsRaw = raw["paths"] as? HashMap<*, *>
    val paths =
      pathsRaw
        ?.mapNotNull { (k, v) ->
          val key = k as? String ?: return@mapNotNull null
          val value = v as? String ?: return@mapNotNull null
          key to value
        }
        ?.toMap()
        ?: emptyMap()
    val languageRows = readLanguageRows(raw["languages"])
    val error = raw["error"] as? String
    return TtsModelDetectResult(
      success = success,
      modelType = modelTypeStr,
      paths = paths,
      languageRows = languageRows,
      error = error,
    )
  }

  private fun readLanguageRows(raw: Any?): List<PublicLanguageRow> {
    val list = raw as? ArrayList<*> ?: return emptyList()
    val out = ArrayList<PublicLanguageRow>(list.size)
    for (entry in list) {
      val row = entry as? HashMap<*, *> ?: continue
      val hint = (row["iso6391Hint"] as? String)?.trim().orEmpty()
      val id = (row["id"] as? String)?.trim().orEmpty()
      if (hint.isEmpty() && id.isEmpty()) {
        continue
      }
      out.add(
        PublicLanguageRow(
          iso6391Hint = if (hint.isNotEmpty()) hint else id,
          id = if (id.isNotEmpty()) id else hint,
        )
      )
    }
    return out
  }
}
