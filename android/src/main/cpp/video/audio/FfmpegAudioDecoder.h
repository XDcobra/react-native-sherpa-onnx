#pragma once

#include <cstdint>
#include <memory>
#include <vector>

#include "VideoTypes.h"

namespace sherpa_onnx {
namespace video {

struct PcmChunk {
  int64_t ptsUs = 0;
  int frames = 0;
  int channels = 0;
  int sampleRate = 0;
  float* data = nullptr;
};

class FfmpegAudioDecoder {
 public:
  FfmpegAudioDecoder();
  ~FfmpegAudioDecoder();

  FfmpegAudioDecoder(const FfmpegAudioDecoder&) = delete;
  FfmpegAudioDecoder& operator=(const FfmpegAudioDecoder&) = delete;

  Status Configure(const AudioTrackInfo& info, int maxOutChannels = 2);
  Status Submit(const EncodedPacket& pkt);
  bool Receive(PcmChunk* out);
  void Flush();
  void ReturnChunk(PcmChunk* chunk);

  int sampleRate() const;
  int channels() const;
  bool configured() const;

 private:
  std::unique_ptr<struct FfmpegAudioDecoderImpl> impl_;
};

}  // namespace video
}  // namespace sherpa_onnx
