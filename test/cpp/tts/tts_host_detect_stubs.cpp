// Host-test stubs: avoid linking the full TTS detect graph.
#include "sherpa-onnx-model-detect.h"

namespace sherpaonnx {

TtsDetectResult DetectTtsModel(
    const std::optional<std::string>& /*modelDir*/,
    const std::optional<std::string>& /*assetName*/,
    const std::string& /*modelType*/,
    const std::string& /*quantization*/,
    bool /*debug*/) {
  TtsDetectResult out;
  out.ok = false;
  out.error = "DetectTtsModel stub: use initializeCustom in host tests";
  return out;
}

}  // namespace sherpaonnx
