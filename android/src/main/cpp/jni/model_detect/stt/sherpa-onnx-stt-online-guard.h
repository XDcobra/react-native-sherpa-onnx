/**
 * sherpa-onnx-stt-online-guard.h
 *
 * Public interface for the STT online-compatibility guard. Validates that a
 * detected STT model can safely be used with the OnlineRecognizer (streaming)
 * path in sherpa-onnx without triggering SHERPA_ONNX_EXIT(-1).
 *
 * Architecture mirrors the enhancement guard but covers 5+ model families:
 *   - Transducer (Icefall + NeMo)
 *   - Paraformer (online)
 *   - CTC variants (Zipformer2, WeNet, NeMo, T-One)
 */
#ifndef SHERPA_ONNX_STT_ONLINE_GUARD_H
#define SHERPA_ONNX_STT_ONLINE_GUARD_H

#include "sherpa-onnx-model-detect.h"

#include <string>

namespace sherpaonnx::stt::online_guard {

struct OnlineGuardResult {
    bool passed = true;
    std::string error;
};

/**
 * Returns true if the given SttModelKind is a candidate for online/streaming
 * use (i.e. sherpa-onnx has an OnlineRecognizer path for it).
 */
bool IsStreamingCandidate(SttModelKind kind);

/**
 * Run safe, non-fatal online-compatibility guard for the given STT model.
 *
 * @param kind       Detected model kind (must be a streaming candidate).
 * @param paths      Resolved model paths (encoder, decoder, joiner, ctcModel, etc.).
 * @param modelDir   Root model directory (for path resolution context).
 * @return           Guard result: passed=true if model is online-compatible,
 *                   passed=false with error string if not.
 *
 * When ORT is not available at compile time, returns {passed=true} (optimistic fallback).
 */
OnlineGuardResult RunOnlineCompatibilityGuard(
    SttModelKind kind,
    const SttModelPaths& paths,
    const std::string& modelDir
);

// Per-family guards — internal, called by RunOnlineCompatibilityGuard.
// Exposed in header for unit testing.

OnlineGuardResult GuardTransducerOnlineCompatibility(
    const SttModelPaths& paths,
    const std::string& modelDir
);

OnlineGuardResult GuardParaformerOnlineCompatibility(
    const SttModelPaths& paths,
    const std::string& modelDir
);

OnlineGuardResult GuardCtcOnlineCompatibility(
    SttModelKind kind,
    const SttModelPaths& paths,
    const std::string& modelDir
);

}  // namespace sherpaonnx::stt::online_guard

#endif  // SHERPA_ONNX_STT_ONLINE_GUARD_H
