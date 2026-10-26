/**
 * Process-lifetime default Ort::Env for OCR sessions.
 * Not a global thread pool — intra-op threads stay on SessionOptions.
 * Never destroyed (avoids static-dtor races with leftover sessions / TLS).
 */
#pragma once

namespace Ort {
class Env;
}

namespace sherpa_onnx {
namespace ocr {

Ort::Env& SharedOrtEnv();

}  // namespace ocr
}  // namespace sherpa_onnx
