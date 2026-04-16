/**
 * sherpa-onnx-stt-online-guard.cpp
 *
 * Dispatcher for STT online-compatibility guard: IsStreamingCandidate()
 * returns whether a model kind has an upstream OnlineRecognizer path,
 * RunOnlineCompatibilityGuard() dispatches to per-family guards.
 */
#include "sherpa-onnx-stt-online-guard.h"

#include "sherpa-onnx-ort-guard-utils.h"

namespace sherpaonnx::stt::online_guard {

bool IsStreamingCandidate(SttModelKind kind) {
    switch (kind) {
        case SttModelKind::kTransducer:
        case SttModelKind::kNemoTransducer:
        case SttModelKind::kParaformer:
        case SttModelKind::kNemoCtc:
        case SttModelKind::kWenetCtc:
        case SttModelKind::kZipformerCtc:
        case SttModelKind::kToneCtc:
            return true;
        default:
            return false;
    }
}

OnlineGuardResult RunOnlineCompatibilityGuard(
    SttModelKind kind,
    const SttModelPaths& paths,
    const std::string& modelDir
) {
#if SHERPA_ONNX_ORT_GUARD_UTILS_HAS_ORT
    switch (kind) {
        case SttModelKind::kTransducer:
        case SttModelKind::kNemoTransducer:
            return GuardTransducerOnlineCompatibility(paths, modelDir);
        case SttModelKind::kParaformer:
            return GuardParaformerOnlineCompatibility(paths, modelDir);
        case SttModelKind::kNemoCtc:
        case SttModelKind::kWenetCtc:
        case SttModelKind::kZipformerCtc:
        case SttModelKind::kToneCtc:
            return GuardCtcOnlineCompatibility(kind, paths, modelDir);
        default:
            return OnlineGuardResult{false, "unsupported kind for online guard"};
    }
#else
    (void)kind; (void)paths; (void)modelDir;
    return OnlineGuardResult{true, ""};
#endif
}

}  // namespace sherpaonnx::stt::online_guard
