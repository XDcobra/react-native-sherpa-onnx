// Host-test stubs: avoid linking the full STT detect graph. Real ValidateSttPaths
// still comes from sherpa-onnx-validate-stt.cpp.
#include "sherpa-onnx-model-detect.h"

namespace sherpaonnx {

SttModelKind ParseSttModelType(const std::string& modelType) {
  if (modelType == "transducer") return SttModelKind::kTransducer;
  if (modelType == "nemo_transducer") return SttModelKind::kNemoTransducer;
  if (modelType == "paraformer") return SttModelKind::kParaformer;
  if (modelType == "nemo_ctc") return SttModelKind::kNemoCtc;
  if (modelType == "wenet_ctc") return SttModelKind::kWenetCtc;
  if (modelType == "sense_voice") return SttModelKind::kSenseVoice;
  if (modelType == "zipformer_ctc" || modelType == "ctc")
    return SttModelKind::kZipformerCtc;
  if (modelType == "whisper") return SttModelKind::kWhisper;
  if (modelType == "fire_red_asr") return SttModelKind::kFireRedAsr;
  if (modelType == "moonshine") return SttModelKind::kMoonshine;
  if (modelType == "moonshine_v2") return SttModelKind::kMoonshineV2;
  if (modelType == "dolphin") return SttModelKind::kDolphin;
  if (modelType == "canary") return SttModelKind::kCanary;
  if (modelType == "omnilingual") return SttModelKind::kOmnilingual;
  if (modelType == "medasr") return SttModelKind::kMedAsr;
  if (modelType == "telespeech_ctc") return SttModelKind::kTeleSpeechCtc;
  if (modelType == "funasr_nano") return SttModelKind::kFunAsrNano;
  if (modelType == "qwen3_asr") return SttModelKind::kQwen3Asr;
  if (modelType == "cohere_transcribe") return SttModelKind::kCohereTranscribe;
  return SttModelKind::kUnknown;
}

SttDetectResult DetectSttModel(
    const std::optional<std::string>& /*modelDir*/,
    const std::optional<std::string>& /*assetName*/,
    const std::string& /*modelType*/,
    const std::string& /*quantization*/,
    bool /*debug*/) {
  SttDetectResult out;
  out.ok = false;
  out.error = "DetectSttModel stub: use initializeCustom in host tests";
  return out;
}

}  // namespace sherpaonnx
