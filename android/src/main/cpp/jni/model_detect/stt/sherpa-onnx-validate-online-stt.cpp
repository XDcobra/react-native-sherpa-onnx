#include "sherpa-onnx-validate-online-stt.h"

#include "sherpa-onnx-model-detect-helper.h"

#include <cstddef>
#include <cstring>

namespace sherpaonnx {
namespace {

using model_detect::ToLower;

struct OnlineSttFieldRequirement {
  const char* fieldName;
  std::string OnlineSttModelPaths::*field;
  bool required;
};

static const OnlineSttFieldRequirement kTransducerReqs[] = {
    {"encoder", &OnlineSttModelPaths::encoder, true},
    {"decoder", &OnlineSttModelPaths::decoder, true},
    {"joiner", &OnlineSttModelPaths::joiner, true},
    {"tokens", &OnlineSttModelPaths::tokens, true},
};

static const OnlineSttFieldRequirement kParaformerReqs[] = {
    {"encoder", &OnlineSttModelPaths::encoder, true},
    {"decoder", &OnlineSttModelPaths::decoder, true},
    {"tokens", &OnlineSttModelPaths::tokens, true},
};

static const OnlineSttFieldRequirement kSingleModelReqs[] = {
    {"model", &OnlineSttModelPaths::model, true},
    {"tokens", &OnlineSttModelPaths::tokens, true},
};

static const OnlineSttFieldRequirement* GetRequirements(
    OnlineSttModelKind kind,
    size_t& count
) {
  switch (kind) {
    case OnlineSttModelKind::kTransducer:
    case OnlineSttModelKind::kNemoTransducer:
      count = std::size(kTransducerReqs);
      return kTransducerReqs;
    case OnlineSttModelKind::kParaformer:
      count = std::size(kParaformerReqs);
      return kParaformerReqs;
    case OnlineSttModelKind::kZipformer2Ctc:
    case OnlineSttModelKind::kNemoCtc:
    case OnlineSttModelKind::kToneCtc:
      count = std::size(kSingleModelReqs);
      return kSingleModelReqs;
    default:
      count = 0;
      return nullptr;
  }
}

static const char* KindToName(OnlineSttModelKind kind) {
  switch (kind) {
    case OnlineSttModelKind::kTransducer:
      return "Transducer";
    case OnlineSttModelKind::kNemoTransducer:
      return "NeMo Transducer";
    case OnlineSttModelKind::kParaformer:
      return "Paraformer";
    case OnlineSttModelKind::kZipformer2Ctc:
      return "Zipformer2 CTC";
    case OnlineSttModelKind::kNemoCtc:
      return "NeMo CTC";
    case OnlineSttModelKind::kToneCtc:
      return "Tone CTC";
    default:
      return "Unknown";
  }
}

}  // namespace

OnlineSttModelKind ParseOnlineSttModelType(const std::string& modelType) {
  const std::string t = ToLower(modelType);
  if (t == "transducer") return OnlineSttModelKind::kTransducer;
  if (t == "nemo_transducer") return OnlineSttModelKind::kNemoTransducer;
  if (t == "paraformer") return OnlineSttModelKind::kParaformer;
  if (t == "zipformer2_ctc" || t == "zipformer_ctc" || t == "ctc") {
    return OnlineSttModelKind::kZipformer2Ctc;
  }
  if (t == "nemo_ctc") return OnlineSttModelKind::kNemoCtc;
  if (t == "tone_ctc") return OnlineSttModelKind::kToneCtc;
  return OnlineSttModelKind::kUnknown;
}

OnlineSttValidationResult ValidateOnlineSttPaths(
    OnlineSttModelKind kind,
    const OnlineSttModelPaths& paths,
    const std::string& contextLabel
) {
  OnlineSttValidationResult result;
  size_t count = 0;
  const auto* reqs = GetRequirements(kind, count);
  if (!reqs) {
    result.ok = false;
    result.error = "Unsupported streaming STT model type";
    return result;
  }

  for (size_t i = 0; i < count; ++i) {
    if (reqs[i].required && (paths.*(reqs[i].field)).empty()) {
      result.missingRequired.push_back(reqs[i].fieldName);
    }
  }

  if (!result.missingRequired.empty()) {
    result.ok = false;
    result.error = std::string("Streaming STT ") + KindToName(kind)
                 + ": missing required files in " + contextLabel + ": ";
    for (size_t i = 0; i < result.missingRequired.size(); ++i) {
      if (i > 0) result.error += ", ";
      result.error += result.missingRequired[i];
    }
  }
  return result;
}

std::vector<CustomPathFieldSpec> GetOnlineSttPathRequirements(OnlineSttModelKind kind) {
  std::vector<CustomPathFieldSpec> specs;
  size_t count = 0;
  const auto* reqs = GetRequirements(kind, count);
  if (!reqs) return specs;
  specs.reserve(count);
  for (size_t i = 0; i < count; ++i) {
    specs.push_back({reqs[i].fieldName, reqs[i].required});
  }
  return specs;
}

}  // namespace sherpaonnx
