#include "streaming-diarizer-factory.h"

#include "sortformer-streaming-model.h"

#include <algorithm>
#include <cctype>

namespace sherpaonnx::diarization {
namespace {

std::string CanonicalStreamingType(std::string type) {
  std::transform(type.begin(), type.end(), type.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  std::replace(type.begin(), type.end(), '-', '_');
  if (type.empty() || type == "auto" || type == "nemotron" ||
      type == "nemotron3" || type == "nemotron_3") {
    return "sortformer";
  }
  return type;
}

}  // namespace

std::unique_ptr<IStreamingDiarizer> CreateStreamingDiarizer(
    const std::string& model_type) {
  const std::string type = CanonicalStreamingType(model_type);
  // Nemotron-3 and Sortformer v2.1 share SortformerStreamingModel.
  (void)type;
  return std::make_unique<SortformerStreamingModel>();
}

}  // namespace sherpaonnx::diarization
