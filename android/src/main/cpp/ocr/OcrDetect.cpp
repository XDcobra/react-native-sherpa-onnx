#include "OcrDetect.h"

#include "sherpa-onnx-model-detect.h"

#include <optional>

namespace sherpa_onnx {
namespace ocr {

namespace {

const char* KindToFamily(sherpaonnx::OcrModelKind kind) {
  if (kind == sherpaonnx::OcrModelKind::kUnknown) return "";
  return sherpaonnx::OcrModelKindToLiteral(kind);
}

}  // namespace

OcrDetectResult DetectOcrModel(const std::string& model_dir,
                               const std::string& model_type,
                               const std::string& quantization) {
  OcrDetectResult out;
  if (model_dir.empty()) {
    out.errorCode = "OCR_INVALID_ARGUMENT";
    out.errorMessage = "modelDir is empty";
    return out;
  }

  const std::string requested =
      model_type.empty() ? std::string("auto") : model_type;

  auto native = sherpaonnx::DetectOcrModel(
      std::optional<std::string>(model_dir), std::nullopt, requested,
      quantization);

  for (const auto src : native.detectionSources) {
    out.detectionSources.push_back(sherpaonnx::DetectionSourceToLiteral(src));
  }

  out.detPath = native.paths.det;
  out.recPath = native.paths.rec;
  out.clsPath = native.paths.cls;
  out.recDictPath = native.paths.rec_dict;
  out.manifestPath = native.paths.manifest;
  out.visionEncoderPath = native.paths.vision_encoder;
  out.visionEncoderDataPath = native.paths.vision_encoder_data;
  out.embedTokensPath = native.paths.embed_tokens;
  out.embedTokensDataPath = native.paths.embed_tokens_data;
  out.decoderPath = native.paths.decoder;
  out.decoderDataPath = native.paths.decoder_data;
  out.tokenizerPath = native.paths.tokenizer;
  out.patchEmbedPath = native.paths.patch_embed;
  out.patchEmbedDataPath = native.paths.patch_embed_data;
  out.posEmbedPath = native.paths.pos_embed;
  out.hasDet = !out.detPath.empty();
  out.hasRec = !out.recPath.empty();
  out.hasCls = !out.clsPath.empty();
  out.hasRecYml = !out.recDictPath.empty();
  out.quantization = native.quantization;
  out.sizeTier = native.sizeTier;

  for (const auto& m : native.detectedModels) {
    out.detectedModels.push_back({m.type, m.modelDir});
  }
  for (const auto& row : native.derivedLanguages) {
    out.languages.push_back({row.iso6391Hint, row.id});
  }

  if (native.ok) {
    out.ok = true;
    out.modelType = KindToFamily(native.selectedKind);
    out.family = out.modelType;
    if (out.detectedModels.empty() && !out.modelType.empty()) {
      out.detectedModels.push_back({out.modelType, model_dir});
    }
    return out;
  }

  out.errorCode = "OCR_DETECT_FAILED";
  out.errorMessage =
      native.error.empty()
          ? ("Unrecognized OCR pack layout in " + model_dir)
          : native.error;
  if (native.selectedKind != sherpaonnx::OcrModelKind::kUnknown) {
    out.modelType = KindToFamily(native.selectedKind);
    out.family = out.modelType;
  }
  if (out.detectedModels.empty() && !out.modelType.empty()) {
    out.detectedModels.push_back({out.modelType, model_dir});
  }
  return out;
}

}  // namespace ocr
}  // namespace sherpa_onnx
