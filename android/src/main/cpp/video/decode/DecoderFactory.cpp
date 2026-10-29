#include "decode/DecoderBackend.h"

#include "decode/FakeDecoder.h"

#include <mutex>

namespace sherpa_onnx {
namespace video {
namespace {

std::mutex gMu;
DecoderFactory gFactory;

}  // namespace

void RegisterDecoderFactory(DecoderFactory factory) {
  std::lock_guard<std::mutex> lock(gMu);
  gFactory = std::move(factory);
}

DecoderFactory GetDecoderFactory() {
  std::lock_guard<std::mutex> lock(gMu);
  if (gFactory) {
    return gFactory;
  }
  return []() -> std::unique_ptr<DecoderBackend> {
    return std::make_unique<FakeDecoderBackend>();
  };
}

void ResetDecoderFactoryForTest() {
  std::lock_guard<std::mutex> lock(gMu);
  gFactory = {};
}

}  // namespace video
}  // namespace sherpa_onnx
