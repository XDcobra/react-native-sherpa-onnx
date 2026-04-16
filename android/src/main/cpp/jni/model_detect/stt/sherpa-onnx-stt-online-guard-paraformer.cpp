/**
 * sherpa-onnx-stt-online-guard-paraformer.cpp
 *
 * Online-compatibility guard for the Paraformer (online) model.
 * Validates that the encoder carries all required metadata to avoid
 * SHERPA_ONNX_EXIT(-1) in online-paraformer-model.cc.
 *
 * Required encoder metadata:
 *   vocab_size, lfr_window_size, lfr_window_shift, encoder_output_size,
 *   decoder_num_blocks, decoder_kernel_size, neg_mean (float vec),
 *   inv_stddev (float vec).
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

OnlineGuardResult GuardParaformerOnlineCompatibility(
    const SttModelPaths& paths,
    const std::string& /*modelDir*/
) {
    OnlineGuardResult out;
    out.passed = false;

    const std::string& modelPath = paths.paraformerModel;
    if (modelPath.empty()) {
        out.error = "paraformer: model path is empty";
        return out;
    }
    if (!FileExists(modelPath)) {
        out.error = "paraformer: model file not found: " + modelPath;
        return out;
    }

    try {
        Ort::Env env(ORT_LOGGING_LEVEL_WARNING, "stt_paraformer_guard");
        Ort::SessionOptions opts;
        Ort::Session session = CreateOrtSession(env, modelPath, opts);
        Ort::ModelMetadata meta = session.GetModelMetadata();
        Ort::AllocatorWithDefaultOptions alloc;

        int32_t vocabSize, lfrWindowSize, lfrWindowShift, encoderOutputSize,
                decoderNumBlocks, decoderKernelSize;
        std::vector<float> negMean, invStddev;

        if (!ReadRequiredMetadataInt32(meta, alloc, "vocab_size", &vocabSize, &out.error) ||
            !ReadRequiredMetadataInt32(meta, alloc, "lfr_window_size", &lfrWindowSize, &out.error) ||
            !ReadRequiredMetadataInt32(meta, alloc, "lfr_window_shift", &lfrWindowShift, &out.error) ||
            !ReadRequiredMetadataInt32(meta, alloc, "encoder_output_size", &encoderOutputSize, &out.error) ||
            !ReadRequiredMetadataInt32(meta, alloc, "decoder_num_blocks", &decoderNumBlocks, &out.error) ||
            !ReadRequiredMetadataInt32(meta, alloc, "decoder_kernel_size", &decoderKernelSize, &out.error) ||
            !ReadRequiredMetadataFloatVec(meta, alloc, "neg_mean", &negMean, &out.error) ||
            !ReadRequiredMetadataFloatVec(meta, alloc, "inv_stddev", &invStddev, &out.error)) {
            return out;
        }

        if (vocabSize <= 0 || lfrWindowSize <= 0 || lfrWindowShift <= 0 ||
            encoderOutputSize <= 0 || decoderNumBlocks <= 0 || decoderKernelSize <= 0) {
            out.error = "paraformer: invalid metadata values (must be > 0)";
            return out;
        }
        if (negMean.empty()) {
            out.error = "paraformer: neg_mean vector is empty";
            return out;
        }
        if (invStddev.empty()) {
            out.error = "paraformer: inv_stddev vector is empty";
            return out;
        }

    } catch (const std::exception& e) {
        out.error = std::string("paraformer guard exception: ") + e.what();
        return out;
    }

    out.passed = true;
    return out;
}

#else  // !SHERPA_ONNX_STT_GUARD_HAS_ORT

OnlineGuardResult GuardParaformerOnlineCompatibility(
    const SttModelPaths& /*paths*/,
    const std::string& /*modelDir*/
) {
    return OnlineGuardResult{true, ""};
}

#endif  // SHERPA_ONNX_STT_GUARD_HAS_ORT

}  // namespace sherpaonnx::stt::online_guard
