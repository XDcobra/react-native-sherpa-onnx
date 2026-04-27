#include "sherpa-onnx-punctuation-online-guard.h"

#include "sherpa-onnx-model-detect-helper.h"
#include "sherpa-onnx-ort-guard-utils.h"

#include <string>

#define SHERPA_ONNX_PUNCTUATION_DETECT_HAS_ORT SHERPA_ONNX_ORT_GUARD_UTILS_HAS_ORT

namespace sherpaonnx::punctuation::online_guard {

using namespace sherpaonnx::model_detect;
using namespace sherpaonnx::ort_guard_utils;

bool IsStreamingCandidate(PunctuationModelKind kind) {
    return kind == PunctuationModelKind::kCnnBilstm;
}

bool LooksLikeAbsolutePath(const std::string& path) {
    return ort_guard_utils::LooksLikeAbsolutePath(path);
}

#if SHERPA_ONNX_PUNCTUATION_DETECT_HAS_ORT

namespace {

bool ExpectInt32Meta(
    const Ort::ModelMetadata& metaData,
    Ort::AllocatorWithDefaultOptions& allocator,
    const char* key,
    int32_t expected,
    std::string* err
) {
    int32_t v = 0;
    if (!ReadRequiredMetadataInt32(metaData, allocator, key, &v, err)) {
        return false;
    }
    if (v != expected) {
        if (err) {
            *err = std::string("punctuation: metadata '") + key + "' is " + std::to_string(v) +
                   " (expected " + std::to_string(expected) + ")";
        }
        return false;
    }
    return true;
}

bool IsRank2WithPositiveSecondDim(
    const std::vector<int64_t>& sh,
    const char* tensorLabel,
    std::string* err
) {
    if (sh.size() != 2) {
        if (err) {
            *err = std::string("punctuation: ") + tensorLabel + " must be rank-2 (got " +
                   ShapeToString(sh) + ")";
        }
        return false;
    }
    if (sh[1] <= 0) {
        if (err) {
            *err = std::string("punctuation: ") + tensorLabel + " second dim must be > 0 (got " +
                   ShapeToString(sh) + ")";
        }
        return false;
    }
    return true;
}

OnlineGuardResult GuardCnnBilstmOnlineCompatibility(const std::string& modelPath) {
    OnlineGuardResult out;
    out.passed = false;

    if (modelPath.empty()) {
        out.error = "resolved CNN-BiLSTM model path is empty";
        return out;
    }
    if (!FileExists(modelPath)) {
        out.error = "resolved CNN-BiLSTM model file does not exist: " + modelPath;
        return out;
    }

    try {
        Ort::Env env(ORT_LOGGING_LEVEL_WARNING, "punctuation_detect_cnn_bilstm_guard");
        Ort::SessionOptions opts;
        Ort::Session session = CreateOrtSession(env, modelPath, opts);
        Ort::ModelMetadata metaData = session.GetModelMetadata();
        Ort::AllocatorWithDefaultOptions allocator;

        if (session.GetInputCount() != 3 || session.GetOutputCount() != 2) {
            out.error = "CNN-BiLSTM online punctuation signature must expose 3 inputs and 2 outputs";
            return out;
        }

        if (!ExpectInt32Meta(metaData, allocator, "COMMA", 1, &out.error) ||
            !ExpectInt32Meta(metaData, allocator, "PERIOD", 2, &out.error) ||
            !ExpectInt32Meta(metaData, allocator, "QUESTION", 3, &out.error) ||
            !ExpectInt32Meta(metaData, allocator, "UPPER", 1, &out.error) ||
            !ExpectInt32Meta(metaData, allocator, "CAP", 2, &out.error) ||
            !ExpectInt32Meta(metaData, allocator, "MIX_CASE", 3, &out.error)) {
            if (out.error.empty()) {
                out.error = "CNN-BiLSTM punctuation metadata read failed";
            }
            return out;
        }

        std::vector<int64_t> caseLogits;
        std::vector<int64_t> punctLogits;
        if (!ReadTensorShape(session, false, 0, &caseLogits, &out.error) ||
            !ReadTensorShape(session, false, 1, &punctLogits, &out.error)) {
            if (out.error.empty()) {
                out.error = "punctuation: cannot read output tensor shapes";
            }
            return out;
        }

        if (!IsRank2WithPositiveSecondDim(caseLogits, "case_logits (output 0)", &out.error) ||
            !IsRank2WithPositiveSecondDim(punctLogits, "punct_logits (output 1)", &out.error)) {
            return out;
        }

        out.passed = true;
        out.error.clear();
        return out;
    } catch (const Ort::Exception& ex) {
        out.error = std::string("failed to inspect CNN-BiLSTM punctuation ONNX: ") + ex.what();
        return out;
    } catch (const std::exception& ex) {
        out.error = std::string("punctuation online guard exception: ") + ex.what();
        return out;
    }
}

}  // namespace

#endif  // SHERPA_ONNX_PUNCTUATION_DETECT_HAS_ORT

OnlineGuardResult RunOnlineCompatibilityGuard(const std::string& cnnBilstmOnnxPath) {
#if SHERPA_ONNX_PUNCTUATION_DETECT_HAS_ORT
    return GuardCnnBilstmOnlineCompatibility(cnnBilstmOnnxPath);
#else
    (void)cnnBilstmOnnxPath;
    return {};
#endif
}

}  // namespace sherpaonnx::punctuation::online_guard
