#include "encode/EncoderBackend.h"
#include "encode/FakeEncoder.h"

#include <mutex>

namespace sherpa_onnx {
namespace video {
namespace {

std::mutex gMu;
EncoderFactory gFactory;

}  // namespace

void RegisterEncoderFactory(EncoderFactory factory) {
  std::lock_guard<std::mutex> lock(gMu);
  gFactory = std::move(factory);
}

EncoderFactory GetEncoderFactory() {
  std::lock_guard<std::mutex> lock(gMu);
  if (gFactory) {
    return gFactory;
  }
  return []() -> std::unique_ptr<EncoderBackend> {
    return std::make_unique<FakeEncoder>();
  };
}

void ResetEncoderFactoryForTest() {
  std::lock_guard<std::mutex> lock(gMu);
  gFactory = {};
}

}  // namespace video
}  // namespace sherpa_onnx
