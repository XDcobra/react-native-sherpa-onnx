/**
 * sherpa-onnx-stt-online-guard-ctc.cpp
 *
 * Online-compatibility guard for CTC model sub-families:
 *   - Zipformer2 CTC  (kZipformerCtc)
 *   - WeNet CTC        (kWenetCtc)
 *   - NeMo CTC         (kNemoCtc)
 *   - T-One CTC        (kToneCtc)
 *
 * Each sub-family has its own metadata requirements. All use a single ONNX
 * file (ctcModel path). The guard validates that the required metadata keys
 * exist and parse correctly so the upstream code won't call SHERPA_ONNX_EXIT(-1).
 */
#include "sherpa-onnx-stt-online-guard.h"

#include "sherpa-onnx-model-detect-helper.h"
#include "sherpa-onnx-ort-guard-utils.h"

#include <string>
#include <vector>

#define SHERPA_ONNX_STT_GUARD_HAS_ORT SHERPA_ONNX_ORT_GUARD_UTILS_HAS_ORT

namespace sherpaonnx::stt::online_guard {

using namespace sherpaonnx::model_detect;
using namespace sherpaonnx::ort_guard_utils;

#if SHERPA_ONNX_STT_GUARD_HAS_ORT

namespace {

// ── Zipformer2 CTC ────────────────────────────────────────────────────

OnlineGuardResult GuardZipformer2Ctc(
    const Ort::ModelMetadata& meta,
    OrtAllocator* alloc
) {
    OnlineGuardResult out;
    out.passed = false;

    std::vector<int32_t> encoderDims, queryHeadDims, valueHeadDims, numHeads,
                         numEncoderLayers, cnnModuleKernels, leftContextLen;
    int32_t T, decodeChunkLen;

    if (!ReadRequiredMetadataInt32Vec(meta, alloc, "encoder_dims", &encoderDims, &out.error) ||
        !ReadRequiredMetadataInt32Vec(meta, alloc, "query_head_dims", &queryHeadDims, &out.error) ||
        !ReadRequiredMetadataInt32Vec(meta, alloc, "value_head_dims", &valueHeadDims, &out.error) ||
        !ReadRequiredMetadataInt32Vec(meta, alloc, "num_heads", &numHeads, &out.error) ||
        !ReadRequiredMetadataInt32Vec(meta, alloc, "num_encoder_layers", &numEncoderLayers, &out.error) ||
        !ReadRequiredMetadataInt32Vec(meta, alloc, "cnn_module_kernels", &cnnModuleKernels, &out.error) ||
        !ReadRequiredMetadataInt32Vec(meta, alloc, "left_context_len", &leftContextLen, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "T", &T, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "decode_chunk_len", &decodeChunkLen, &out.error)) {
        return out;
    }
    if (encoderDims.empty() || numEncoderLayers.empty() || T <= 0 || decodeChunkLen <= 0) {
        out.error = "zipformer2 CTC: invalid metadata (empty vectors or non-positive scalars)";
        return out;
    }
    out.passed = true;
    return out;
}

// ── WeNet CTC ─────────────────────────────────────────────────────────

OnlineGuardResult GuardWenetCtc(
    const Ort::ModelMetadata& meta,
    OrtAllocator* alloc
) {
    OnlineGuardResult out;
    out.passed = false;

    int32_t head, numBlocks, outputSize, cnnModuleKernel, rightContext,
            subsamplingFactor, vocabSize;

    if (!ReadRequiredMetadataInt32(meta, alloc, "head", &head, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "num_blocks", &numBlocks, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "output_size", &outputSize, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "cnn_module_kernel", &cnnModuleKernel, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "right_context", &rightContext, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "subsampling_factor", &subsamplingFactor, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "vocab_size", &vocabSize, &out.error)) {
        return out;
    }
    if (head <= 0 || numBlocks <= 0 || outputSize <= 0 || subsamplingFactor <= 0 || vocabSize <= 0) {
        out.error = "WeNet CTC: invalid metadata values (must be > 0)";
        return out;
    }
    out.passed = true;
    return out;
}

// ── NeMo CTC ──────────────────────────────────────────────────────────

OnlineGuardResult GuardNemoCtc(
    const Ort::ModelMetadata& meta,
    OrtAllocator* alloc
) {
    OnlineGuardResult out;
    out.passed = false;

    int32_t windowSize, chunkShift, subsamplingFactor, vocabSize,
            cacheLastChannelDim1, cacheLastChannelDim2, cacheLastChannelDim3,
            cacheLastTimeDim1, cacheLastTimeDim2, cacheLastTimeDim3;

    if (!ReadRequiredMetadataInt32(meta, alloc, "window_size", &windowSize, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "chunk_shift", &chunkShift, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "subsampling_factor", &subsamplingFactor, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "vocab_size", &vocabSize, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "cache_last_channel_dim1", &cacheLastChannelDim1, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "cache_last_channel_dim2", &cacheLastChannelDim2, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "cache_last_channel_dim3", &cacheLastChannelDim3, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "cache_last_time_dim1", &cacheLastTimeDim1, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "cache_last_time_dim2", &cacheLastTimeDim2, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "cache_last_time_dim3", &cacheLastTimeDim3, &out.error)) {
        return out;
    }
    if (windowSize <= 0 || chunkShift <= 0 || subsamplingFactor <= 0 || vocabSize <= 0) {
        out.error = "NeMo CTC: invalid metadata values (must be > 0)";
        return out;
    }
    out.passed = true;
    return out;
}

// ── T-One CTC ─────────────────────────────────────────────────────────

OnlineGuardResult GuardToneCtc(
    const Ort::ModelMetadata& meta,
    OrtAllocator* alloc
) {
    OnlineGuardResult out;
    out.passed = false;

    int32_t frameLengthMs, stateDim, sampleRate;

    if (!ReadRequiredMetadataInt32(meta, alloc, "frame_length_ms", &frameLengthMs, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "state_dim", &stateDim, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "sample_rate", &sampleRate, &out.error)) {
        return out;
    }
    if (frameLengthMs <= 0 || stateDim <= 0 || sampleRate <= 0) {
        out.error = "T-One CTC: invalid metadata values (must be > 0)";
        return out;
    }
    out.passed = true;
    return out;
}

}  // anonymous namespace

// ── Public entry point ─────────────────────────────────────────────────

OnlineGuardResult GuardCtcOnlineCompatibility(
    SttModelKind kind,
    const SttModelPaths& paths,
    const std::string& /*modelDir*/
) {
    OnlineGuardResult out;
    out.passed = false;

    const std::string& modelPath = paths.ctcModel;
    if (modelPath.empty()) {
        out.error = "CTC guard: ctcModel path is empty";
        return out;
    }
    if (!FileExists(modelPath)) {
        out.error = "CTC guard: model file not found: " + modelPath;
        return out;
    }

    try {
        Ort::Env env(ORT_LOGGING_LEVEL_WARNING, "stt_ctc_guard");
        Ort::SessionOptions opts;
        Ort::Session session = CreateOrtSession(env, modelPath, opts);
        Ort::ModelMetadata meta = session.GetModelMetadata();
        Ort::AllocatorWithDefaultOptions alloc;

        switch (kind) {
            case SttModelKind::kZipformerCtc:
                return GuardZipformer2Ctc(meta, alloc);
            case SttModelKind::kWenetCtc:
                return GuardWenetCtc(meta, alloc);
            case SttModelKind::kNemoCtc:
                return GuardNemoCtc(meta, alloc);
            case SttModelKind::kToneCtc:
                return GuardToneCtc(meta, alloc);
            default:
                out.error = "CTC guard: unexpected model kind";
                return out;
        }
    } catch (const std::exception& e) {
        out.error = std::string("CTC guard exception: ") + e.what();
        return out;
    }
}

#else  // !SHERPA_ONNX_STT_GUARD_HAS_ORT

OnlineGuardResult GuardCtcOnlineCompatibility(
    SttModelKind /*kind*/,
    const SttModelPaths& /*paths*/,
    const std::string& /*modelDir*/
) {
    return OnlineGuardResult{true, ""};
}

#endif  // SHERPA_ONNX_STT_GUARD_HAS_ORT

}  // namespace sherpaonnx::stt::online_guard
