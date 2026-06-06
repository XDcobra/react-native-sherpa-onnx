package com.sherpaonnx.stt.config

import com.facebook.react.bridge.ReadableMap
import com.sherpaonnx.bridge.InitModeModelPathsParser

/** Parse `initializeOnlineStt(instanceId, options)` TurboModule map. */
internal object OnlineSttInitOptionsParser {
  data class Parsed(
    val initMode: String,
    val modelDir: String?,
    val modelPaths: Map<String, String>?,
    val modelType: String?,
    val enableEndpoint: Boolean?,
    val decodingMethod: String?,
    val maxActivePaths: Int?,
    val hotwordsFile: String?,
    val hotwordsScore: Double?,
    val numThreads: Double?,
    val provider: String?,
    val ruleFsts: String?,
    val ruleFars: String?,
    val dither: Double?,
    val blankPenalty: Double?,
    val debug: Boolean?,
    val rule1MustContainNonSilence: Boolean?,
    val rule1MinTrailingSilence: Double?,
    val rule1MinUtteranceLength: Double?,
    val rule2MustContainNonSilence: Boolean?,
    val rule2MinTrailingSilence: Double?,
    val rule2MinUtteranceLength: Double?,
    val rule3MustContainNonSilence: Boolean?,
    val rule3MinTrailingSilence: Double?,
    val rule3MinUtteranceLength: Double?,
  )

  fun parse(options: ReadableMap): Parsed? {
    val core = InitModeModelPathsParser.parseCore(options) ?: return null

    return Parsed(
      initMode = core.initMode,
      modelDir = core.modelDir,
      modelPaths = core.modelPaths,
      modelType = core.modelType ?: if (options.hasKey("modelType")) options.getString("modelType") else null,
      enableEndpoint = if (options.hasKey("enableEndpoint")) options.getBoolean("enableEndpoint") else null,
      decodingMethod = if (options.hasKey("decodingMethod")) options.getString("decodingMethod") else null,
      maxActivePaths = if (options.hasKey("maxActivePaths")) options.getDouble("maxActivePaths").toInt() else null,
      hotwordsFile = if (options.hasKey("hotwordsFile")) options.getString("hotwordsFile") else null,
      hotwordsScore = if (options.hasKey("hotwordsScore")) options.getDouble("hotwordsScore") else null,
      numThreads = if (options.hasKey("numThreads")) options.getDouble("numThreads") else null,
      provider = if (options.hasKey("provider")) options.getString("provider") else null,
      ruleFsts = if (options.hasKey("ruleFsts")) options.getString("ruleFsts") else null,
      ruleFars = if (options.hasKey("ruleFars")) options.getString("ruleFars") else null,
      dither = if (options.hasKey("dither")) options.getDouble("dither") else null,
      blankPenalty = if (options.hasKey("blankPenalty")) options.getDouble("blankPenalty") else null,
      debug = if (options.hasKey("debug")) options.getBoolean("debug") else null,
      rule1MustContainNonSilence = if (options.hasKey("rule1MustContainNonSilence")) options.getBoolean("rule1MustContainNonSilence") else null,
      rule1MinTrailingSilence = if (options.hasKey("rule1MinTrailingSilence")) options.getDouble("rule1MinTrailingSilence") else null,
      rule1MinUtteranceLength = if (options.hasKey("rule1MinUtteranceLength")) options.getDouble("rule1MinUtteranceLength") else null,
      rule2MustContainNonSilence = if (options.hasKey("rule2MustContainNonSilence")) options.getBoolean("rule2MustContainNonSilence") else null,
      rule2MinTrailingSilence = if (options.hasKey("rule2MinTrailingSilence")) options.getDouble("rule2MinTrailingSilence") else null,
      rule2MinUtteranceLength = if (options.hasKey("rule2MinUtteranceLength")) options.getDouble("rule2MinUtteranceLength") else null,
      rule3MustContainNonSilence = if (options.hasKey("rule3MustContainNonSilence")) options.getBoolean("rule3MustContainNonSilence") else null,
      rule3MinTrailingSilence = if (options.hasKey("rule3MinTrailingSilence")) options.getDouble("rule3MinTrailingSilence") else null,
      rule3MinUtteranceLength = if (options.hasKey("rule3MinUtteranceLength")) options.getDouble("rule3MinUtteranceLength") else null,
    )
  }
}
