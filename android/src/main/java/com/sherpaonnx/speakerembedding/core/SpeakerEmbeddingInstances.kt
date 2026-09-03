package com.sherpaonnx.speakerembedding.core

import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractor
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingManager

internal data class SpeakerEmbeddingExtractorInstance(
  @Volatile var extractor: SpeakerEmbeddingExtractor? = null,
  @Volatile var dim: Int = 0,
) {
  fun release() {
    extractor?.release()
    extractor = null
    dim = 0
  }
}

internal data class SpeakerEmbeddingManagerInstance(
  @Volatile var manager: SpeakerEmbeddingManager? = null,
) {
  fun release() {
    manager?.release()
    manager = null
  }
}
