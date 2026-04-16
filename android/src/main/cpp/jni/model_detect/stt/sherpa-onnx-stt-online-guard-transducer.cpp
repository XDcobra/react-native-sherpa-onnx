/**
 * sherpa-onnx-stt-online-guard-transducer.cpp
 *
 * Online-compatibility guard for Transducer models (Icefall + NeMo).
 *
 * Validates that encoder/decoder/joiner files exist and that the encoder
 * carries the metadata required by the upstream OnlineRecognizer to avoid
 * SHERPA_ONNX_EXIT(-1).
 *
 * Model type dispatch (Icefall only):
 *   encoder metadata "model_type" → conformer | ebranchformer | lstm |
 *   zipformer | zipformer2. Each sub-type has its own required metadata set.
 *
 * NeMo transducer is identified when the decoder ONNX has >1 output
 * (the prediction network carries LSTM state outputs).
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

// ── Icefall sub-type guards ────────────────────────────────────────────

OnlineGuardResult GuardConformerEncoder(
    const Ort::ModelMetadata& meta,
    OrtAllocator* alloc
) {
    OnlineGuardResult out;
    out.passed = false;

    int32_t numEncoderLayers, T, decodeChunkLen, leftContext, encoderDim, padLength, cnnModuleKernel;
    if (!ReadRequiredMetadataInt32(meta, alloc, "num_encoder_layers", &numEncoderLayers, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "T", &T, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "decode_chunk_len", &decodeChunkLen, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "left_context", &leftContext, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "encoder_dim", &encoderDim, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "pad_length", &padLength, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "cnn_module_kernel", &cnnModuleKernel, &out.error)) {
        return out;
    }
    if (numEncoderLayers <= 0 || T <= 0 || decodeChunkLen <= 0 || encoderDim <= 0) {
        out.error = "conformer encoder: invalid metadata values (must be > 0)";
        return out;
    }
    out.passed = true;
    return out;
}

OnlineGuardResult GuardEbranchformerEncoder(
    const Ort::ModelMetadata& meta,
    OrtAllocator* alloc
) {
    OnlineGuardResult out;
    out.passed = false;

    int32_t decodeChunkLen, T, numHiddenLayers, hiddenSize, intermediateSize,
            csguKernelSize, mergeConvKernel, leftContextLen, numHeads, headDim;
    if (!ReadRequiredMetadataInt32(meta, alloc, "decode_chunk_len", &decodeChunkLen, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "T", &T, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "num_hidden_layers", &numHiddenLayers, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "hidden_size", &hiddenSize, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "intermediate_size", &intermediateSize, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "csgu_kernel_size", &csguKernelSize, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "merge_conv_kernel", &mergeConvKernel, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "left_context_len", &leftContextLen, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "num_heads", &numHeads, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "head_dim", &headDim, &out.error)) {
        return out;
    }
    if (numHiddenLayers <= 0 || hiddenSize <= 0 || T <= 0 || decodeChunkLen <= 0) {
        out.error = "ebranchformer encoder: invalid metadata values (must be > 0)";
        return out;
    }
    out.passed = true;
    return out;
}

OnlineGuardResult GuardLstmEncoder(
    const Ort::ModelMetadata& meta,
    OrtAllocator* alloc
) {
    OnlineGuardResult out;
    out.passed = false;

    int32_t numEncoderLayers, T, decodeChunkLen, rnnHiddenSize, dModel;
    if (!ReadRequiredMetadataInt32(meta, alloc, "num_encoder_layers", &numEncoderLayers, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "T", &T, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "decode_chunk_len", &decodeChunkLen, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "rnn_hidden_size", &rnnHiddenSize, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "d_model", &dModel, &out.error)) {
        return out;
    }
    if (numEncoderLayers <= 0 || T <= 0 || decodeChunkLen <= 0 || rnnHiddenSize <= 0 || dModel <= 0) {
        out.error = "lstm encoder: invalid metadata values (must be > 0)";
        return out;
    }
    out.passed = true;
    return out;
}

OnlineGuardResult GuardZipformerEncoder(
    const Ort::ModelMetadata& meta,
    OrtAllocator* alloc
) {
    OnlineGuardResult out;
    out.passed = false;

    std::vector<int32_t> encoderDims, attentionDims, numEncoderLayers, cnnModuleKernels, leftContextLen;
    int32_t T, decodeChunkLen;
    if (!ReadRequiredMetadataInt32Vec(meta, alloc, "encoder_dims", &encoderDims, &out.error) ||
        !ReadRequiredMetadataInt32Vec(meta, alloc, "attention_dims", &attentionDims, &out.error) ||
        !ReadRequiredMetadataInt32Vec(meta, alloc, "num_encoder_layers", &numEncoderLayers, &out.error) ||
        !ReadRequiredMetadataInt32Vec(meta, alloc, "cnn_module_kernels", &cnnModuleKernels, &out.error) ||
        !ReadRequiredMetadataInt32Vec(meta, alloc, "left_context_len", &leftContextLen, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "T", &T, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "decode_chunk_len", &decodeChunkLen, &out.error)) {
        return out;
    }
    if (encoderDims.empty() || numEncoderLayers.empty() || T <= 0 || decodeChunkLen <= 0) {
        out.error = "zipformer encoder: invalid metadata (empty vectors or non-positive scalars)";
        return out;
    }
    out.passed = true;
    return out;
}

OnlineGuardResult GuardZipformer2Encoder(
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
        out.error = "zipformer2 encoder: invalid metadata (empty vectors or non-positive scalars)";
        return out;
    }
    out.passed = true;
    return out;
}

// ── NeMo Transducer guard ──────────────────────────────────────────────

OnlineGuardResult GuardNemoTransducerEncoder(
    const Ort::ModelMetadata& meta,
    OrtAllocator* alloc
) {
    OnlineGuardResult out;
    out.passed = false;

    int32_t vocabSize, windowSize, chunkShift, subsamplingFactor,
            predRnnLayers, predHidden,
            cacheLastChannelDim1, cacheLastChannelDim2, cacheLastChannelDim3,
            cacheLastTimeDim1, cacheLastTimeDim2, cacheLastTimeDim3;

    if (!ReadRequiredMetadataInt32(meta, alloc, "vocab_size", &vocabSize, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "window_size", &windowSize, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "chunk_shift", &chunkShift, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "subsampling_factor", &subsamplingFactor, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "pred_rnn_layers", &predRnnLayers, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "pred_hidden", &predHidden, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "cache_last_channel_dim1", &cacheLastChannelDim1, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "cache_last_channel_dim2", &cacheLastChannelDim2, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "cache_last_channel_dim3", &cacheLastChannelDim3, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "cache_last_time_dim1", &cacheLastTimeDim1, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "cache_last_time_dim2", &cacheLastTimeDim2, &out.error) ||
        !ReadRequiredMetadataInt32(meta, alloc, "cache_last_time_dim3", &cacheLastTimeDim3, &out.error)) {
        return out;
    }
    if (vocabSize <= 0 || windowSize <= 0 || chunkShift <= 0 || subsamplingFactor <= 0 ||
        predRnnLayers <= 0 || predHidden <= 0) {
        out.error = "NeMo transducer encoder: invalid metadata values (must be > 0)";
        return out;
    }
    out.passed = true;
    return out;
}

// ── Icefall Transducer dispatcher ──────────────────────────────────────

OnlineGuardResult GuardIcefallTransducer(
    const std::string& encoderPath,
    const std::string& decoderPath,
    const std::string& joinerPath
) {
    OnlineGuardResult out;
    out.passed = false;

    try {
        Ort::Env env(ORT_LOGGING_LEVEL_WARNING, "stt_transducer_guard");
        Ort::SessionOptions opts;

        // ── Encoder ────────────────────────────────────────────────
        Ort::Session encoderSession = CreateOrtSession(env, encoderPath, opts);
        Ort::ModelMetadata encoderMeta = encoderSession.GetModelMetadata();
        Ort::AllocatorWithDefaultOptions alloc;

        std::string modelType;
        if (!ReadRequiredMetadataString(encoderMeta, alloc, "model_type", &modelType, &out.error)) {
            return out;
        }

        if (modelType == "conformer") {
            out = GuardConformerEncoder(encoderMeta, alloc);
        } else if (modelType == "ebranchformer") {
            out = GuardEbranchformerEncoder(encoderMeta, alloc);
        } else if (modelType == "lstm") {
            out = GuardLstmEncoder(encoderMeta, alloc);
        } else if (modelType == "zipformer") {
            out = GuardZipformerEncoder(encoderMeta, alloc);
        } else if (modelType == "zipformer2") {
            out = GuardZipformer2Encoder(encoderMeta, alloc);
        } else {
            out.error = "unknown transducer encoder model_type: '" + modelType + "'";
            return out;
        }
        if (!out.passed) return out;

        // ── Decoder ────────────────────────────────────────────────
        Ort::Session decoderSession = CreateOrtSession(env, decoderPath, opts);
        Ort::ModelMetadata decoderMeta = decoderSession.GetModelMetadata();

        int32_t vocabSize, contextSize;
        if (!ReadRequiredMetadataInt32(decoderMeta, alloc, "vocab_size", &vocabSize, &out.error) ||
            !ReadRequiredMetadataInt32(decoderMeta, alloc, "context_size", &contextSize, &out.error)) {
            out.passed = false;
            return out;
        }
        if (vocabSize <= 0 || contextSize <= 0) {
            out.passed = false;
            out.error = "transducer decoder: vocab_size/context_size must be > 0";
            return out;
        }

        // ── Joiner ─────────────────────────────────────────────────
        // Joiner has no required metadata; just verify it loads.
        Ort::Session joinerSession = CreateOrtSession(env, joinerPath, opts);
        (void)joinerSession;

    } catch (const std::exception& e) {
        out.passed = false;
        out.error = std::string("transducer guard exception: ") + e.what();
        return out;
    }

    out.passed = true;
    return out;
}

}  // anonymous namespace

// ── Public entry point ─────────────────────────────────────────────────

OnlineGuardResult GuardTransducerOnlineCompatibility(
    const SttModelPaths& paths,
    const std::string& /*modelDir*/
) {
    OnlineGuardResult out;
    out.passed = false;

    // Validate required files exist
    if (paths.encoder.empty()) {
        out.error = "transducer: encoder path is empty";
        return out;
    }
    if (paths.decoder.empty()) {
        out.error = "transducer: decoder path is empty";
        return out;
    }
    if (paths.joiner.empty()) {
        out.error = "transducer: joiner path is empty";
        return out;
    }
    if (!FileExists(paths.encoder)) {
        out.error = "transducer: encoder file not found: " + paths.encoder;
        return out;
    }
    if (!FileExists(paths.decoder)) {
        out.error = "transducer: decoder file not found: " + paths.decoder;
        return out;
    }
    if (!FileExists(paths.joiner)) {
        out.error = "transducer: joiner file not found: " + paths.joiner;
        return out;
    }

    // Decide between NeMo and Icefall by probing decoder output count.
    // NeMo decoder has >1 output (state outputs); Icefall decoders have exactly 1.
    try {
        Ort::Env env(ORT_LOGGING_LEVEL_WARNING, "stt_transducer_probe");
        Ort::SessionOptions opts;
        Ort::Session decoderProbe = CreateOrtSession(env, paths.decoder, opts);
        size_t decoderOutputCount = decoderProbe.GetOutputCount();

        if (decoderOutputCount > 1) {
            // NeMo transducer — validate from encoder metadata
            Ort::Session encoderSession = CreateOrtSession(env, paths.encoder, opts);
            Ort::ModelMetadata encoderMeta = encoderSession.GetModelMetadata();
            Ort::AllocatorWithDefaultOptions alloc;
            return GuardNemoTransducerEncoder(encoderMeta, alloc);
        }
    } catch (const std::exception& e) {
        out.error = std::string("transducer probe exception: ") + e.what();
        return out;
    }

    // Icefall transducer
    return GuardIcefallTransducer(paths.encoder, paths.decoder, paths.joiner);
}

#else  // !SHERPA_ONNX_STT_GUARD_HAS_ORT

OnlineGuardResult GuardTransducerOnlineCompatibility(
    const SttModelPaths& /*paths*/,
    const std::string& /*modelDir*/
) {
    return OnlineGuardResult{true, ""};
}

#endif  // SHERPA_ONNX_STT_GUARD_HAS_ORT

}  // namespace sherpaonnx::stt::online_guard
