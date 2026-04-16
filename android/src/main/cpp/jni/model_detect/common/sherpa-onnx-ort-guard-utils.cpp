/**
 * sherpa-onnx-ort-guard-utils.cpp
 *
 * Shared ORT (ONNX Runtime) utility implementations for online-compatibility guards.
 * See sherpa-onnx-ort-guard-utils.h for API documentation.
 */
#include "sherpa-onnx-ort-guard-utils.h"

#include <cctype>
#include <cerrno>
#include <climits>
#include <cstdlib>
#include <limits>

namespace sherpaonnx::ort_guard_utils {

// ── Path helpers ───────────────────────────────────────────────────────

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

// ── Parsing helpers ────────────────────────────────────────────────────

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
    char* endp = nullptr;
    long v = std::strtol(text.c_str(), &endp, 10);
    if (endp == text.c_str()) {
        return false;
    }
    while (*endp != '\0' && std::isspace(static_cast<unsigned char>(*endp))) {
        ++endp;
    }
    if (*endp != '\0' || errno == ERANGE ||
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
    char* endp = nullptr;
    long long v = std::strtoll(text.c_str(), &endp, 10);
    if (endp == text.c_str()) {
        return false;
    }
    while (*endp != '\0' && std::isspace(static_cast<unsigned char>(*endp))) {
        ++endp;
    }
    if (*endp != '\0' || errno == ERANGE) {
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
    char* endp = nullptr;
    float v = std::strtof(text.c_str(), &endp);
    if (endp == text.c_str()) {
        return false;
    }
    while (*endp != '\0' && std::isspace(static_cast<unsigned char>(*endp))) {
        ++endp;
    }
    if (*endp != '\0' || errno == ERANGE) {
        return false;
    }
    *out = v;
    return true;
}

bool ParseCsvInt32(const std::string& text, std::vector<int32_t>* out) {
    if (!out) {
        return false;
    }
    out->clear();
    if (text.empty()) {
        return false;
    }
    size_t begin = 0;
    while (begin <= text.size()) {
        size_t pos = text.find(',', begin);
        std::string token =
            text.substr(begin, pos == std::string::npos ? std::string::npos : pos - begin);
        TrimAsciiInPlace(&token);
        if (!token.empty()) {
            int32_t value = 0;
            if (!ParseInt32Strict(token, &value)) {
                out->clear();
                return false;
            }
            out->push_back(value);
        }
        if (pos == std::string::npos) {
            break;
        }
        begin = pos + 1;
    }
    return !out->empty();
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
        size_t pos = text.find(',', begin);
        std::string token =
            text.substr(begin, pos == std::string::npos ? std::string::npos : pos - begin);
        TrimAsciiInPlace(&token);
        if (!token.empty()) {
            int64_t value = 0;
            if (!ParseInt64Strict(token, &value)) {
                out->clear();
                return false;
            }
            out->push_back(value);
        }
        if (pos == std::string::npos) {
            break;
        }
        begin = pos + 1;
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
        size_t pos = text.find(',', begin);
        std::string token =
            text.substr(begin, pos == std::string::npos ? std::string::npos : pos - begin);
        TrimAsciiInPlace(&token);
        if (!token.empty()) {
            float value = 0.f;
            if (!ParseFloatStrict(token, &value)) {
                out->clear();
                return false;
            }
            out->push_back(value);
        }
        if (pos == std::string::npos) {
            break;
        }
        begin = pos + 1;
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

// ── ORT metadata / session helpers ─────────────────────────────────────

#if SHERPA_ONNX_ORT_GUARD_UTILS_HAS_ORT

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

bool ReadOptionalMetadataString(
    const Ort::ModelMetadata& metaData,
    OrtAllocator* allocator,
    const char* key,
    std::string* out
) {
    std::string value = LookupMetadataValue(metaData, key, allocator);
    if (out) {
        *out = value;
    }
    return true;
}

bool ReadRequiredMetadataInt32Vec(
    const Ort::ModelMetadata& metaData,
    OrtAllocator* allocator,
    const char* key,
    std::vector<int32_t>* out,
    std::string* error
) {
    std::string value = LookupMetadataValue(metaData, key, allocator);
    if (value.empty()) {
        if (error) {
            *error = std::string("missing required metadata '") + key + "'";
        }
        return false;
    }
    if (!ParseCsvInt32(value, out)) {
        if (error) {
            *error = std::string("invalid integer-vector metadata '") + key + "': " + value;
        }
        return false;
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

#endif  // SHERPA_ONNX_ORT_GUARD_UTILS_HAS_ORT

}  // namespace sherpaonnx::ort_guard_utils
