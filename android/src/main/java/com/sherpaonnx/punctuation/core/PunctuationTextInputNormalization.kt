package com.sherpaonnx.punctuation.core

object PunctuationTextInputNormalization {
  const val MODE_NONE = "none"
  const val MODE_LOWER = "lower"
  const val DEFAULT_MODE = MODE_LOWER

  fun resolve(mode: String?): String {
    return when (mode) {
      MODE_NONE, MODE_LOWER -> mode
      else -> DEFAULT_MODE
    }
  }

  fun normalize(text: String, mode: String?): String {
    return when (resolve(mode)) {
      MODE_NONE -> text
      else -> text.lowercase()
    }
  }
}
