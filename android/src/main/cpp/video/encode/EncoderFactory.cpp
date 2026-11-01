#include "encode/EncoderBackend.h"
#include "encode/FakeEncoder.h"

#include "VideoLog.h"
#include "codec/CodecCatalog.h"

#ifdef HAVE_FFMPEG
#include "encode/FfmpegVideoEncoder.h"
extern "C" {
#include <libavcodec/avcodec.h>
}
#endif

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
}

void RegisterFakeEncoderProvidersForTest() { RegisterFakeEncoderProviders(); }

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

void RegisterBundledVideoSwEncoders() {
#ifdef HAVE_FFMPEG
  using sherpa_onnx::codec::CodecCatalog;
  using sherpa_onnx::codec::Direction;
  using sherpa_onnx::codec::Media;
  using sherpa_onnx::codec::Origin;
  using sherpa_onnx::codec::Provider;
  using sherpa_onnx::codec::Reason;
  using sherpa_onnx::codec::Tier;
  const AVCodec* found = avcodec_find_encoder_by_name("libvpx_vp9");
  Provider p;
  p.media = Media::Video;
  p.dir = Direction::Encode;
  p.codec = "vp9";
  p.tier = Tier::Software;
  p.origin = Origin::Bundled;
  p.name = "ffmpeg.vp9";
  p.caps.maxW = 7680;
  p.caps.maxH = 4320;
  p.available = found != nullptr;
  p.unavailableReason = found ? Reason::None : Reason::Disabled;
  VIDEO_LOGI("video.encode ffmpeg register ffmpeg.vp9 found=%d",
             found != nullptr ? 1 : 0);
  CodecCatalog::Instance().Register(std::move(p));
#endif
}

std::unique_ptr<EncoderBackend> OpenEncoderForProvider(
    const std::string& providerName) {
  if (providerName.empty() || providerName == "fake" ||
      providerName.rfind("fake.", 0) == 0) {
    return GetEncoderFactory()();
  }
#ifdef HAVE_FFMPEG
  if (providerName.rfind("ffmpeg.", 0) == 0) {
    return std::make_unique<FfmpegVideoEncoder>();
  }
#endif
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
