#include "sherpa-onnx-speaker-embedding-online-guard.h"

#include "sherpa-onnx-model-detect-helper.h"
#include "sherpa-onnx-ort-guard-utils.h"

#include <exception>
#include <string>

#define SHERPA_ONNX_SPEAKER_EMBEDDING_DETECT_HAS_ORT SHERPA_ONNX_ORT_GUARD_UTILS_HAS_ORT

namespace sherpaonnx::speaker_embedding::online_guard {

using namespace sherpaonnx::model_detect;
using namespace sherpaonnx::ort_guard_utils;

bool LooksLikeAbsolutePath(const std::string& path) {
    return sherpaonnx::ort_guard_utils::LooksLikeAbsolutePath(path);
}

#if SHERPA_ONNX_SPEAKER_EMBEDDING_DETECT_HAS_ORT

namespace {

const char* KindToFramework(SpeakerEmbeddingModelKind kind) {
    switch (kind) {
        case SpeakerEmbeddingModelKind::kWespeaker:
            return "wespeaker";
        case SpeakerEmbeddingModelKind::k3dSpeaker:
            return "3d-speaker";
        case SpeakerEmbeddingModelKind::kNemo:
            return "nemo";
        default:
            return "";
    }
}

OnlineGuardResult GuardCommonAndKind(
    SpeakerEmbeddingModelKind kind,
    const std::string& modelPath
) {
    OnlineGuardResult out;
    out.passed = false;

    if (modelPath.empty()) {
        out.error = "resolved speaker-embedding model path is empty";
        return out;
    }
    if (!FileExists(modelPath)) {
        out.error = "resolved speaker-embedding model file does not exist: " + modelPath;
        return out;
    }

    const char* expectedFramework = KindToFramework(kind);
    if (expectedFramework[0] == '\0') {
        out.error = "unknown speaker-embedding kind for metadata guard";
        return out;
    }

    try {
        Ort::Env env(ORT_LOGGING_LEVEL_WARNING, "speaker_embedding_detect_guard");
        Ort::SessionOptions opts;
        Ort::Session session = CreateOrtSession(env, modelPath, opts);

        Ort::ModelMetadata metaData = session.GetModelMetadata();
        Ort::AllocatorWithDefaultOptions allocator;

        std::string framework;
        if (!ReadRequiredMetadataString(metaData, allocator, "framework", &framework, &out.error)) {
            return out;
        }
        if (framework != expectedFramework) {
            out.error = "metadata framework is '" + framework + "' (expected '" +
                        expectedFramework + "')";
            return out;
        }

        int32_t outputDim = 0;
        int32_t sampleRate = 0;
        std::string language;
        if (!ReadRequiredMetadataInt32(metaData, allocator, "output_dim", &outputDim, &out.error) ||
            !ReadRequiredMetadataInt32(metaData, allocator, "sample_rate", &sampleRate, &out.error) ||
            !ReadRequiredMetadataString(metaData, allocator, "language", &language, &out.error)) {
            return out;
        }
        if (outputDim <= 0 || sampleRate <= 0) {
            out.error = "invalid speaker-embedding metadata (output_dim/sample_rate must be > 0)";
            return out;
        }
        if (language.empty()) {
            out.error = "metadata language is empty";
            return out;
        }

        if (kind == SpeakerEmbeddingModelKind::kWespeaker ||
            kind == SpeakerEmbeddingModelKind::k3dSpeaker) {
            int32_t normalizeSamples = 0;
            if (!ReadRequiredMetadataInt32(
                    metaData, allocator, "normalize_samples", &normalizeSamples, &out.error)) {
                return out;
            }
            if (normalizeSamples != 0 && normalizeSamples != 1) {
                out.error = "metadata normalize_samples must be 0 or 1";
                return out;
            }
        } else if (kind == SpeakerEmbeddingModelKind::kNemo) {
            int32_t featDim = 0;
            int32_t windowSizeMs = 0;
            int32_t windowStrideMs = 0;
            if (!ReadRequiredMetadataInt32(metaData, allocator, "feat_dim", &featDim, &out.error) ||
                !ReadRequiredMetadataInt32(
                    metaData, allocator, "window_size_ms", &windowSizeMs, &out.error) ||
                !ReadRequiredMetadataInt32(
                    metaData, allocator, "window_stride_ms", &windowStrideMs, &out.error)) {
                return out;
            }
            if (featDim <= 0 || windowSizeMs <= 0 || windowStrideMs <= 0) {
                out.error =
                    "invalid NeMo speaker-embedding metadata "
                    "(feat_dim/window_size_ms/window_stride_ms must be > 0)";
                return out;
            }
        }

        out.passed = true;
        out.error.clear();
        return out;
    } catch (const Ort::Exception& ex) {
        out.error = std::string("failed to inspect speaker-embedding ONNX model: ") + ex.what();
        return out;
    } catch (const std::exception& ex) {
        out.error = std::string("speaker-embedding guard exception: ") + ex.what();
        return out;
    }
}

}  // namespace

#endif  // SHERPA_ONNX_SPEAKER_EMBEDDING_DETECT_HAS_ORT

OnlineGuardResult RunOnlineCompatibilityGuard(
    SpeakerEmbeddingModelKind kind,
    const std::string& modelPath
) {
#if SHERPA_ONNX_SPEAKER_EMBEDDING_DETECT_HAS_ORT
    switch (kind) {
        case SpeakerEmbeddingModelKind::kWespeaker:
        case SpeakerEmbeddingModelKind::k3dSpeaker:
        case SpeakerEmbeddingModelKind::kNemo:
            return GuardCommonAndKind(kind, modelPath);
        default:
            return {};
    }
#else
    (void)kind;
    (void)modelPath;
    return {};
#endif
}

}  // namespace sherpaonnx::speaker_embedding::online_guard
