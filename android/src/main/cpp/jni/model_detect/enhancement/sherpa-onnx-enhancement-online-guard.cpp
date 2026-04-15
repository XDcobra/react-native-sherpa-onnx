#include "sherpa-onnx-enhancement-online-guard.h"

#include "sherpa-onnx-model-detect-helper.h"

#include <array>
#include <cctype>
#include <cerrno>
#include <climits>
#include <cstdlib>
#include <exception>
#include <limits>
#include <string>
#include <vector>

#if !defined(SHERPA_ONNX_MODEL_DETECT_DISABLE_ORT_GUARD)
#if defined(__has_include)
#if __has_include("onnxruntime_cxx_api.h")
#define SHERPA_ONNX_ENHANCEMENT_DETECT_HAS_ORT 1
#include "onnxruntime_cxx_api.h"  // NOLINT
#else
#define SHERPA_ONNX_ENHANCEMENT_DETECT_HAS_ORT 0
#endif
#else
#define SHERPA_ONNX_ENHANCEMENT_DETECT_HAS_ORT 0
#endif
#else
#define SHERPA_ONNX_ENHANCEMENT_DETECT_HAS_ORT 0
#endif

namespace sherpaonnx::enhancement::online_guard {

using namespace sherpaonnx::model_detect;

bool IsStreamingCandidate(EnhancementModelKind kind) {
    return kind == EnhancementModelKind::kGtcrn ||
           kind == EnhancementModelKind::kDpdfNet;
}

bool LooksLikeAbsolutePath(const std::string& path) {
    if (path.empty()) {
        return false;
    }
    if (path[0] == '/' || path[0] == '\\') {
        return true;
    }
    return path.size() > 2 &&
           std::isalpha(static_cast<unsigned char>(path[0])) &&
           path[1] == ':' &&
           (path[2] == '\\' || path[2] == '/');
}

#if SHERPA_ONNX_ENHANCEMENT_DETECT_HAS_ORT

namespace {

void TrimAsciiInPlace(std::string* text) {
    if (!text) {
        return;
    }
    size_t begin = 0;
    while (begin < text->size() &&
           std::isspace(static_cast<unsigned char>((*text)[begin]))) {
        ++begin;
    }
    size_t end = text->size();
    while (end > begin &&
           std::isspace(static_cast<unsigned char>((*text)[end - 1]))) {
        --end;
    }
    *text = text->substr(begin, end - begin);
}

bool ParseInt32Strict(const std::string& text, int32_t* out) {
    if (!out || text.empty()) {
        return false;
    }
    errno = 0;
    char* end = nullptr;
    long v = std::strtol(text.c_str(), &end, 10);
    if (end == text.c_str()) {
        return false;
    }
    while (*end != '\0' && std::isspace(static_cast<unsigned char>(*end))) {
        ++end;
    }
    if (*end != '\0' || errno == ERANGE ||
        v < static_cast<long>(std::numeric_limits<int32_t>::min()) ||
        v > static_cast<long>(std::numeric_limits<int32_t>::max())) {
        return false;
    }
    *out = static_cast<int32_t>(v);
    return true;
}

bool ParseInt64Strict(const std::string& text, int64_t* out) {
    if (!out || text.empty()) {
        return false;
    }
    errno = 0;
    char* end = nullptr;
    long long v = std::strtoll(text.c_str(), &end, 10);
    if (end == text.c_str()) {
        return false;
    }
    while (*end != '\0' && std::isspace(static_cast<unsigned char>(*end))) {
        ++end;
    }
    if (*end != '\0' || errno == ERANGE) {
        return false;
    }
    *out = static_cast<int64_t>(v);
    return true;
}

bool ParseFloatStrict(const std::string& text, float* out) {
    if (!out || text.empty()) {
        return false;
    }
    errno = 0;
    char* end = nullptr;
    float v = std::strtof(text.c_str(), &end);
    if (end == text.c_str()) {
        return false;
    }
    while (*end != '\0' && std::isspace(static_cast<unsigned char>(*end))) {
        ++end;
    }
    if (*end != '\0' || errno == ERANGE) {
        return false;
    }
    *out = v;
    return true;
}

bool ParseCsvInt64(const std::string& text, std::vector<int64_t>* out) {
    if (!out) {
        return false;
    }
    out->clear();
    if (text.empty()) {
        return false;
    }

    size_t begin = 0;
    while (begin <= text.size()) {
        size_t end = text.find(',', begin);
        std::string token =
            text.substr(begin, end == std::string::npos ? std::string::npos : end - begin);
        TrimAsciiInPlace(&token);
        if (!token.empty()) {
            int64_t value = 0;
            if (!ParseInt64Strict(token, &value)) {
                out->clear();
                return false;
            }
            out->push_back(value);
        }
        if (end == std::string::npos) {
            break;
        }
        begin = end + 1;
    }

    return !out->empty();
}

bool ParseCsvFloat(const std::string& text, std::vector<float>* out) {
    if (!out) {
        return false;
    }
    out->clear();
    if (text.empty()) {
        return false;
    }

    size_t begin = 0;
    while (begin <= text.size()) {
        size_t end = text.find(',', begin);
        std::string token =
            text.substr(begin, end == std::string::npos ? std::string::npos : end - begin);
        TrimAsciiInPlace(&token);
        if (!token.empty()) {
            float value = 0.f;
            if (!ParseFloatStrict(token, &value)) {
                out->clear();
                return false;
            }
            out->push_back(value);
        }
        if (end == std::string::npos) {
            break;
        }
        begin = end + 1;
    }

    return !out->empty();
}

std::string ShapeToString(const std::vector<int64_t>& shape) {
    std::string out = "[";
    for (size_t i = 0; i < shape.size(); ++i) {
        if (i > 0) {
            out += ", ";
        }
        out += std::to_string(shape[i]);
    }
    out += "]";
    return out;
}

std::string LookupMetadataValue(
    const Ort::ModelMetadata& metaData,
    const char* key,
    OrtAllocator* allocator
) {
#if ORT_API_VERSION >= 12
    auto value = metaData.LookupCustomMetadataMapAllocated(key, allocator);
    return value ? std::string(value.get()) : std::string();
#else
    char* value = metaData.LookupCustomMetadataMap(key, allocator);
    std::string ans = value ? value : "";
    allocator->Free(allocator, value);
    return ans;
#endif
}

bool ReadRequiredMetadataString(
    const Ort::ModelMetadata& metaData,
    OrtAllocator* allocator,
    const char* key,
    std::string* out,
    std::string* error
) {
    std::string value = LookupMetadataValue(metaData, key, allocator);
    if (value.empty()) {
        if (error) {
            *error = std::string("missing required metadata '") + key + "'";
        }
        return false;
    }
    if (out) {
        *out = value;
    }
    return true;
}

bool ReadRequiredMetadataInt32(
    const Ort::ModelMetadata& metaData,
    OrtAllocator* allocator,
    const char* key,
    int32_t* out,
    std::string* error
) {
    std::string value = LookupMetadataValue(metaData, key, allocator);
    if (value.empty()) {
        if (error) {
            *error = std::string("missing required metadata '") + key + "'";
        }
        return false;
    }
    int32_t parsed = 0;
    if (!ParseInt32Strict(value, &parsed)) {
        if (error) {
            *error = std::string("invalid integer metadata '") + key + "': " + value;
        }
        return false;
    }
    if (out) {
        *out = parsed;
    }
    return true;
}

bool ReadOptionalMetadataInt32(
    const Ort::ModelMetadata& metaData,
    OrtAllocator* allocator,
    const char* key,
    int32_t defaultValue,
    int32_t* out,
    std::string* error
) {
    std::string value = LookupMetadataValue(metaData, key, allocator);
    if (value.empty()) {
        if (out) {
            *out = defaultValue;
        }
        return true;
    }
    int32_t parsed = 0;
    if (!ParseInt32Strict(value, &parsed)) {
        if (error) {
            *error = std::string("invalid integer metadata '") + key + "': " + value;
        }
        return false;
    }
    if (out) {
        *out = parsed;
    }
    return true;
}

bool ReadRequiredMetadataInt64Vec(
    const Ort::ModelMetadata& metaData,
    OrtAllocator* allocator,
    const char* key,
    std::vector<int64_t>* out,
    std::string* error
) {
    std::string value = LookupMetadataValue(metaData, key, allocator);
    if (value.empty()) {
        if (error) {
            *error = std::string("missing required metadata '") + key + "'";
        }
        return false;
    }
    if (!ParseCsvInt64(value, out)) {
        if (error) {
            *error = std::string("invalid integer-vector metadata '") + key + "': " + value;
        }
        return false;
    }
    return true;
}

bool ReadRequiredMetadataFloatVec(
    const Ort::ModelMetadata& metaData,
    OrtAllocator* allocator,
    const char* key,
    std::vector<float>* out,
    std::string* error
) {
    std::string value = LookupMetadataValue(metaData, key, allocator);
    if (value.empty()) {
        if (error) {
            *error = std::string("missing required metadata '") + key + "'";
        }
        return false;
    }
    if (!ParseCsvFloat(value, out)) {
        if (error) {
            *error = std::string("invalid float-vector metadata '") + key + "': " + value;
        }
        return false;
    }
    return true;
}

bool ReadTensorShape(
    const Ort::Session& session,
    bool input,
    size_t index,
    std::vector<int64_t>* out,
    std::string* error
) {
    try {
        auto typeInfo = input ? session.GetInputTypeInfo(index)
                              : session.GetOutputTypeInfo(index);
        auto tensorInfo = typeInfo.GetTensorTypeAndShapeInfo();
        if (out) {
            *out = tensorInfo.GetShape();
        }
        return true;
    } catch (const Ort::Exception& ex) {
        if (error) {
            *error = std::string("cannot read ") +
                     (input ? "input" : "output") +
                     " tensor shape at index " +
                     std::to_string(index) +
                     ": " + ex.what();
        }
        return false;
    }
}

Ort::Session CreateOrtSession(
    Ort::Env& env,
    const std::string& modelPath,
    const Ort::SessionOptions& opts
) {
#if defined(_WIN32)
    std::wstring widePath(modelPath.begin(), modelPath.end());
    return Ort::Session(env, widePath.c_str(), opts);
#else
    return Ort::Session(env, modelPath.c_str(), opts);
#endif
}

OnlineGuardResult GuardGtcrnOnlineCompatibility(const std::string& modelPath) {
    OnlineGuardResult out;
    out.passed = false;

    if (modelPath.empty()) {
        out.error = "resolved GTCRN model path is empty";
        return out;
    }
    if (!FileExists(modelPath)) {
        out.error = "resolved GTCRN model file does not exist: " + modelPath;
        return out;
    }

    try {
        Ort::Env env(ORT_LOGGING_LEVEL_WARNING, "enhancement_detect_gtcrn_guard");
        Ort::SessionOptions opts;
        Ort::Session session = CreateOrtSession(env, modelPath, opts);

        Ort::ModelMetadata metaData = session.GetModelMetadata();
        Ort::AllocatorWithDefaultOptions allocator;

        std::string modelType;
        if (!ReadRequiredMetadataString(metaData, allocator, "model_type", &modelType, &out.error)) {
            return out;
        }
        if (modelType != "gtcrn") {
            out.error = "metadata model_type is '" + modelType + "' (expected 'gtcrn')";
            return out;
        }

        int32_t sampleRate = 0;
        int32_t nFft = 0;
        int32_t hopLength = 0;
        int32_t windowLength = 0;
        int32_t version = 0;
        std::string windowType;

        if (!ReadRequiredMetadataInt32(metaData, allocator, "sample_rate", &sampleRate, &out.error) ||
            !ReadRequiredMetadataInt32(metaData, allocator, "n_fft", &nFft, &out.error) ||
            !ReadRequiredMetadataInt32(metaData, allocator, "hop_length", &hopLength, &out.error) ||
            !ReadRequiredMetadataInt32(metaData, allocator, "window_length", &windowLength, &out.error) ||
            !ReadRequiredMetadataInt32(metaData, allocator, "version", &version, &out.error) ||
            !ReadRequiredMetadataString(metaData, allocator, "window_type", &windowType, &out.error)) {
            return out;
        }

        if (sampleRate <= 0 || nFft <= 0 || hopLength <= 0 || windowLength <= 0) {
            out.error = "invalid GTCRN metadata values (sample_rate/n_fft/hop_length/window_length must be > 0)";
            return out;
        }
        if (version < 0) {
            out.error = "invalid GTCRN metadata value: version must be >= 0";
            return out;
        }
        if (windowType.empty()) {
            out.error = "missing GTCRN metadata window_type";
            return out;
        }

        std::vector<int64_t> convCacheShape;
        std::vector<int64_t> traCacheShape;
        std::vector<int64_t> interCacheShape;
        if (!ReadRequiredMetadataInt64Vec(metaData, allocator, "conv_cache_shape", &convCacheShape, &out.error) ||
            !ReadRequiredMetadataInt64Vec(metaData, allocator, "tra_cache_shape", &traCacheShape, &out.error) ||
            !ReadRequiredMetadataInt64Vec(metaData, allocator, "inter_cache_shape", &interCacheShape, &out.error)) {
            return out;
        }

        if (session.GetInputCount() != 4 || session.GetOutputCount() != 4) {
            out.error = "GTCRN online signature must expose exactly 4 inputs and 4 outputs";
            return out;
        }

        std::vector<int64_t> xShape;
        std::vector<int64_t> convInShape;
        std::vector<int64_t> traInShape;
        std::vector<int64_t> interInShape;
        std::vector<int64_t> yShape;
        std::vector<int64_t> convOutShape;
        std::vector<int64_t> traOutShape;
        std::vector<int64_t> interOutShape;

        if (!ReadTensorShape(session, true, 0, &xShape, &out.error) ||
            !ReadTensorShape(session, true, 1, &convInShape, &out.error) ||
            !ReadTensorShape(session, true, 2, &traInShape, &out.error) ||
            !ReadTensorShape(session, true, 3, &interInShape, &out.error) ||
            !ReadTensorShape(session, false, 0, &yShape, &out.error) ||
            !ReadTensorShape(session, false, 1, &convOutShape, &out.error) ||
            !ReadTensorShape(session, false, 2, &traOutShape, &out.error) ||
            !ReadTensorShape(session, false, 3, &interOutShape, &out.error)) {
            return out;
        }

        const int64_t expectedNumBins = static_cast<int64_t>(nFft / 2 + 1);
        if (xShape.size() != 4 || xShape[0] != 1 || xShape[1] != expectedNumBins ||
            xShape[2] != 1 || xShape[3] != 2) {
            out.error = "GTCRN online input shape must be [1, num_bins, 1, 2], got " + ShapeToString(xShape);
            return out;
        }

        if (yShape != xShape) {
            out.error = "GTCRN online output[0] shape must match input[0], got " + ShapeToString(yShape);
            return out;
        }

        if (convInShape != convCacheShape || traInShape != traCacheShape ||
            interInShape != interCacheShape) {
            out.error = "GTCRN cache input shapes do not match metadata cache shapes";
            return out;
        }

        if (convOutShape != convCacheShape || traOutShape != traCacheShape ||
            interOutShape != interCacheShape) {
            out.error = "GTCRN cache output shapes do not match metadata cache shapes";
            return out;
        }

        out.passed = true;
        out.error.clear();
        return out;
    } catch (const Ort::Exception& ex) {
        out.error = std::string("failed to inspect GTCRN ONNX model: ") + ex.what();
        return out;
    } catch (const std::exception& ex) {
        out.error = std::string("GTCRN guard exception: ") + ex.what();
        return out;
    }
}

OnlineGuardResult GuardDpdfNetOnlineCompatibility(const std::string& modelPath) {
    OnlineGuardResult out;
    out.passed = false;

    if (modelPath.empty()) {
        out.error = "resolved DPDFNet model path is empty";
        return out;
    }
    if (!FileExists(modelPath)) {
        out.error = "resolved DPDFNet model file does not exist: " + modelPath;
        return out;
    }

    try {
        Ort::Env env(ORT_LOGGING_LEVEL_WARNING, "enhancement_detect_dpdfnet_guard");
        Ort::SessionOptions opts;
        Ort::Session session = CreateOrtSession(env, modelPath, opts);

        Ort::ModelMetadata metaData = session.GetModelMetadata();
        Ort::AllocatorWithDefaultOptions allocator;

        std::string modelType;
        std::string profile;
        std::string windowType;
        std::string padMode;
        if (!ReadRequiredMetadataString(metaData, allocator, "model_type", &modelType, &out.error) ||
            !ReadRequiredMetadataString(metaData, allocator, "profile", &profile, &out.error) ||
            !ReadRequiredMetadataString(metaData, allocator, "window_type", &windowType, &out.error) ||
            !ReadRequiredMetadataString(metaData, allocator, "pad_mode", &padMode, &out.error)) {
            return out;
        }

        if (modelType != "dpdfnet") {
            out.error = "metadata model_type is '" + modelType + "' (expected 'dpdfnet')";
            return out;
        }

        if (profile != "dpdfnet_16khz" && profile != "dpdfnet2_48khz_hr") {
            out.error = "DPDFNet profile is not supported for online streaming: " + profile;
            return out;
        }
        if (windowType.empty() || padMode.empty()) {
            out.error = "DPDFNet metadata window_type/pad_mode must be non-empty";
            return out;
        }

        int32_t sampleRate = 0;
        int32_t nFft = 0;
        int32_t hopLength = 0;
        int32_t windowLength = 0;
        int32_t freqBinsMeta = 0;
        int32_t erbBins = 0;
        int32_t specBins = 0;
        int32_t stateSizeMeta = 0;
        int32_t erbNormStateSize = 0;
        int32_t specNormStateSize = 0;
        int32_t normalized = 0;
        int32_t center = 1;

        if (!ReadRequiredMetadataInt32(metaData, allocator, "sample_rate", &sampleRate, &out.error) ||
            !ReadRequiredMetadataInt32(metaData, allocator, "n_fft", &nFft, &out.error) ||
            !ReadRequiredMetadataInt32(metaData, allocator, "hop_length", &hopLength, &out.error) ||
            !ReadRequiredMetadataInt32(metaData, allocator, "window_length", &windowLength, &out.error) ||
            !ReadRequiredMetadataInt32(metaData, allocator, "freq_bins", &freqBinsMeta, &out.error) ||
            !ReadRequiredMetadataInt32(metaData, allocator, "erb_bins", &erbBins, &out.error) ||
            !ReadRequiredMetadataInt32(metaData, allocator, "spec_bins", &specBins, &out.error) ||
            !ReadRequiredMetadataInt32(metaData, allocator, "state_size", &stateSizeMeta, &out.error) ||
            !ReadRequiredMetadataInt32(metaData, allocator, "erb_norm_state_size", &erbNormStateSize, &out.error) ||
            !ReadRequiredMetadataInt32(metaData, allocator, "spec_norm_state_size", &specNormStateSize, &out.error) ||
            !ReadOptionalMetadataInt32(metaData, allocator, "normalized", 0, &normalized, &out.error) ||
            !ReadOptionalMetadataInt32(metaData, allocator, "center", 1, &center, &out.error)) {
            return out;
        }

        if (normalized < 0 || normalized > 1 || center < 0 || center > 1) {
            out.error = "DPDFNet metadata normalized/center must be 0 or 1";
            return out;
        }

        if (sampleRate <= 0 || nFft <= 0 || hopLength <= 0 || windowLength <= 0 ||
            freqBinsMeta <= 1 || erbBins <= 0 || specBins <= 0 || stateSizeMeta <= 0) {
            out.error =
                "invalid DPDFNet metadata values (sample_rate/n_fft/hop_length/window_length/freq_bins/erb_bins/spec_bins/state_size)";
            return out;
        }

        std::vector<float> erbNormInit;
        std::vector<float> specNormInit;
        if (!ReadRequiredMetadataFloatVec(metaData, allocator, "erb_norm_init", &erbNormInit, &out.error) ||
            !ReadRequiredMetadataFloatVec(metaData, allocator, "spec_norm_init", &specNormInit, &out.error)) {
            return out;
        }

        if (session.GetInputCount() != 2 || session.GetOutputCount() != 2) {
            out.error = "DPDFNet online signature must expose exactly 2 inputs and 2 outputs";
            return out;
        }

        std::vector<int64_t> specShape;
        std::vector<int64_t> stateShape;
        std::vector<int64_t> outSpecShape;
        std::vector<int64_t> outStateShape;
        if (!ReadTensorShape(session, true, 0, &specShape, &out.error) ||
            !ReadTensorShape(session, true, 1, &stateShape, &out.error) ||
            !ReadTensorShape(session, false, 0, &outSpecShape, &out.error) ||
            !ReadTensorShape(session, false, 1, &outStateShape, &out.error)) {
            return out;
        }

        if (specShape.size() != 4 || specShape[0] != 1 || specShape[1] != 1 || specShape[3] != 2) {
            out.error = "DPDFNet online input[0] shape must be [1, 1, F, 2], got " + ShapeToString(specShape);
            return out;
        }
        if (stateShape.size() != 1) {
            out.error = "DPDFNet online input[1] state shape must be [S], got " + ShapeToString(stateShape);
            return out;
        }

        const int64_t freqBinsGraph = specShape[2];
        const int64_t stateSizeGraph = stateShape[0];
        if (freqBinsGraph <= 1 || stateSizeGraph <= 0) {
            out.error = "DPDFNet graph exposes invalid freq/state dimensions";
            return out;
        }

        if (outSpecShape.size() != 4 || outSpecShape[0] != 1 || outSpecShape[1] != 1 ||
            outSpecShape[2] != freqBinsGraph || outSpecShape[3] != 2) {
            out.error = "DPDFNet online output[0] shape must match [1, 1, F, 2], got " + ShapeToString(outSpecShape);
            return out;
        }
        if (outStateShape.size() != 1 || outStateShape[0] != stateSizeGraph) {
            out.error = "DPDFNet online output[1] shape must match [S], got " + ShapeToString(outStateShape);
            return out;
        }

        if (freqBinsMeta != static_cast<int32_t>(freqBinsGraph)) {
            out.error = "DPDFNet metadata freq_bins does not match graph shape";
            return out;
        }
        if (nFft != static_cast<int32_t>((freqBinsGraph - 1) * 2)) {
            out.error = "DPDFNet metadata n_fft does not match graph frequency bins";
            return out;
        }
        if (stateSizeMeta != static_cast<int32_t>(stateSizeGraph)) {
            out.error = "DPDFNet metadata state_size does not match graph state tensor";
            return out;
        }

        if (erbNormStateSize != static_cast<int32_t>(erbNormInit.size()) ||
            specNormStateSize != static_cast<int32_t>(specNormInit.size())) {
            out.error = "DPDFNet normalization state sizes do not match metadata init vectors";
            return out;
        }

        if (erbNormStateSize <= 0 || specNormStateSize <= 0 ||
            stateSizeMeta < erbNormStateSize + specNormStateSize) {
            out.error = "DPDFNet normalization/state_size metadata is inconsistent";
            return out;
        }

        out.passed = true;
        out.error.clear();
        return out;
    } catch (const Ort::Exception& ex) {
        out.error = std::string("failed to inspect DPDFNet ONNX model: ") + ex.what();
        return out;
    } catch (const std::exception& ex) {
        out.error = std::string("DPDFNet guard exception: ") + ex.what();
        return out;
    }
}

}  // namespace

#endif  // SHERPA_ONNX_ENHANCEMENT_DETECT_HAS_ORT

OnlineGuardResult RunOnlineCompatibilityGuard(
    EnhancementModelKind kind,
    const std::string& modelPath
) {
#if SHERPA_ONNX_ENHANCEMENT_DETECT_HAS_ORT
    switch (kind) {
        case EnhancementModelKind::kGtcrn:
            return GuardGtcrnOnlineCompatibility(modelPath);
        case EnhancementModelKind::kDpdfNet:
            return GuardDpdfNetOnlineCompatibility(modelPath);
        default:
            return {};
    }
#else
    (void)kind;
    (void)modelPath;
    return {};
#endif
}

}  // namespace sherpaonnx::enhancement::online_guard
