#include "encode/EncoderBackend.h"
#include "encode/FakeEncoder.h"

#include "codec/CodecCatalog.h"

#ifdef __ANDROID__
#include "platform/android/AMediaCodecEncoder.h"
#endif

#include <mutex>

namespace sherpa_onnx {
namespace video {
namespace {

std::mutex gMu;
EncoderFactory gFactory;
NamedEncoderOpener gNamedOpener;

void RegisterFakeEncoderProviders() {
  using sherpa_onnx::codec::CodecCatalog;
  using sherpa_onnx::codec::Direction;
  using sherpa_onnx::codec::Media;
  using sherpa_onnx::codec::Origin;
  using sherpa_onnx::codec::Provider;
  using sherpa_onnx::codec::Tier;
  for (const char* codec : {"h264", "hevc"}) {
    Provider p;
    p.media = Media::Video;
    p.dir = Direction::Encode;
    p.codec = codec;
    p.tier = Tier::Hardware;
    p.origin = Origin::Platform;
    p.name = "fake";
    p.caps.maxW = 7680;
    p.caps.maxH = 4320;
    CodecCatalog::Instance().Register(p);
  }
}

}  // namespace

void RegisterEncoderFactory(EncoderFactory factory) {
  std::lock_guard<std::mutex> lock(gMu);
  gFactory = std::move(factory);
  RegisterFakeEncoderProviders();
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

void SetNamedEncoderOpener(NamedEncoderOpener opener) {
  std::lock_guard<std::mutex> lock(gMu);
  gNamedOpener = std::move(opener);
}

std::unique_ptr<EncoderBackend> OpenEncoderForProvider(
    const std::string& providerName) {
  if (providerName.empty() || providerName == "fake" ||
      providerName.rfind("fake.", 0) == 0) {
    return GetEncoderFactory()();
  }
  NamedEncoderOpener named;
  {
    std::lock_guard<std::mutex> lock(gMu);
    named = gNamedOpener;
  }
  if (named) {
    return named(providerName);
  }
#ifdef __ANDROID__
  auto enc = std::make_unique<AMediaCodecEncoder>();
  enc->SetAllowedCodecName(providerName);
  return enc;
#endif
  return GetEncoderFactory()();
}

}  // namespace video
}  // namespace sherpa_onnx
