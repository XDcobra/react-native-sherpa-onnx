#include "sherpa-onnx-validate-punctuation.h"

#include <cstddef>
#include <sstream>

namespace sherpaonnx {
namespace {

const char* KindToName(PunctuationModelKind kind) {
    switch (kind) {
        case PunctuationModelKind::kCtTransformer:
            return "CT-Transformer (offline)";
        case PunctuationModelKind::kCnnBilstm:
            return "CNN-BiLSTM (online)";
        default:
            return "Unknown";
    }
}

}  // namespace

PunctuationValidationResult ValidatePunctuationPaths(
    PunctuationModelKind kind,
    const PunctuationModelPaths& paths,
    const std::string& modelDir
) {
    PunctuationValidationResult result;
    switch (kind) {
        case PunctuationModelKind::kCtTransformer:
            if (paths.ct_transformer.empty()) {
                result.missingRequired.push_back("ct_transformer");
            }
            break;
        case PunctuationModelKind::kCnnBilstm:
            if (paths.cnn_bilstm.empty()) {
                result.missingRequired.push_back("cnn_bilstm");
            }
            if (paths.bpe_vocab.empty()) {
                result.missingRequired.push_back("bpe_vocab");
            }
            break;
        default:
            result.ok = false;
            result.error = "Punctuation: unknown model kind";
            return result;
    }

    if (!result.missingRequired.empty()) {
        result.ok = false;
        std::ostringstream os;
        os << "Punctuation " << KindToName(kind) << ": missing required paths in " << modelDir
           << ": ";
        for (size_t i = 0; i < result.missingRequired.size(); ++i) {
            if (i > 0) os << ", ";
            os << result.missingRequired[i];
        }
        result.error = os.str();
    }
    return result;
}

}  // namespace sherpaonnx
