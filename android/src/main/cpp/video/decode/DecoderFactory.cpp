#include "decode/DecoderBackend.h"

#include "codec/CodecCatalog.h"
#include "codec/CodecTypes.h"
#include "decode/FakeDecoder.h"
#ifdef HAVE_FFMPEG
#include "decode/FfmpegVideoDecoder.h"
extern "C" {
#include <libavcodec/avcodec.h>
}
#endif
#ifdef __ANDROID__
#include "platform/android/AMediaCodecDecoder.h"
#endif

#include <mutex>

namespace sherpa_onnx {
namespace video {
namespace {

std::mutex gMu;
DecoderFactory gFactory;
NamedDecoderOpener gNamedOpener;

void RegisterFakeDecoderProviders() {
  using sherpa_onnx::codec::CodecCatalog;
  using sherpa_onnx::codec::Media;
  using sherpa_onnx::codec::Direction;
  using sherpa_onnx::codec::Origin;
  using sherpa_onnx::codec::Provider;
  using sherpa_onnx::codec::Tier;
  for (const char* codec : {"h264", "hevc"}) {
    Provider p;
    p.media = Media::Video;
    p.dir = Direction::Decode;
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

void RegisterDecoderFactory(DecoderFactory factory) {
  std::lock_guard<std::mutex> lock(gMu);
  gFactory = std::move(factory);
  RegisterFakeDecoderProviders();
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

void RegisterNamedVideoCodec(const char* name, const char* codec, bool encoder,
                             bool hardware, int minW, int minH, int maxW,
                             int maxH, int alignW, int alignH,
                             int64_t maxBlocks, int blockW, int blockH,
                             int maxInstances, double fps1080Low) {
  using sherpa_onnx::codec::CodecCatalog;
  using sherpa_onnx::codec::Direction;
  using sherpa_onnx::codec::Media;
  using sherpa_onnx::codec::Origin;
  using sherpa_onnx::codec::Provider;
  using sherpa_onnx::codec::Tier;
  if (name == nullptr || codec == nullptr || name[0] == '\0') return;
  Provider p;
  p.media = Media::Video;
  p.dir = encoder ? Direction::Encode : Direction::Decode;
  p.codec = codec;
  p.tier = hardware ? Tier::Hardware : Tier::Software;
  p.origin = Origin::Platform;
  p.name = name;
  p.caps.minW = minW;
  p.caps.minH = minH;
  p.caps.maxW = maxW;
  p.caps.maxH = maxH;
  p.caps.widthAlign = alignW > 0 ? alignW : 1;
  p.caps.heightAlign = alignH > 0 ? alignH : 1;
  p.caps.maxBlocks = maxBlocks;
  p.caps.blockW = blockW > 0 ? blockW : 16;
  p.caps.blockH = blockH > 0 ? blockH : 16;
  p.caps.maxInstancesHint = maxInstances;
  p.caps.measuredFps1080Low =
      fps1080Low > 0 ? fps1080Low
                     : (hardware ? 0.0 : sherpa_onnx::codec::kDefaultMeasuredFps1080Low);
  CodecCatalog::Instance().Register(std::move(p));
}

void SetNamedDecoderOpener(NamedDecoderOpener opener) {
  std::lock_guard<std::mutex> lock(gMu);
  gNamedOpener = std::move(opener);
}

std::unique_ptr<DecoderBackend> OpenDecoderForProvider(
    const std::string& providerName) {
  if (providerName.empty() || providerName == "fake" ||
      providerName.rfind("fake.", 0) == 0) {
    return GetDecoderFactory()();
  }
#ifdef HAVE_FFMPEG
  if (providerName.rfind("ffmpeg.", 0) == 0) {
    return std::make_unique<FfmpegVideoDecoder>();
  }
#endif
  NamedDecoderOpener named;
  {
    std::lock_guard<std::mutex> lock(gMu);
    named = gNamedOpener;
  }
  if (named) {
    return named(providerName);
  }
#ifdef __ANDROID__
  auto dec = std::make_unique<AMediaCodecDecoder>();
  dec->SetAllowedCodecName(providerName);
  return dec;
#endif
  return GetDecoderFactory()();
}

void RegisterBundledVideoSwDecoders() {
#ifdef HAVE_FFMPEG
  using sherpa_onnx::codec::CodecCatalog;
  using sherpa_onnx::codec::Direction;
  using sherpa_onnx::codec::Media;
  using sherpa_onnx::codec::Origin;
  using sherpa_onnx::codec::Provider;
  using sherpa_onnx::codec::Reason;
  using sherpa_onnx::codec::Tier;
  auto reg = [](const char* name, const char* codec, AVCodecID id) {
    const AVCodec* found = avcodec_find_decoder(id);
    Provider p;
    p.media = Media::Video;
    p.dir = Direction::Decode;
    p.codec = codec;
    p.tier = Tier::Software;
    p.origin = Origin::Bundled;
    p.name = name;
    p.caps.maxW = 7680;
    p.caps.maxH = 4320;
    p.available = found != nullptr;
    p.unavailableReason = found ? Reason::None : Reason::Disabled;
    CodecCatalog::Instance().Register(std::move(p));
  };
  reg("ffmpeg.h264", "h264", AV_CODEC_ID_H264);
  reg("ffmpeg.hevc", "hevc", AV_CODEC_ID_HEVC);
#endif
}

}  // namespace video
}  // namespace sherpa_onnx
