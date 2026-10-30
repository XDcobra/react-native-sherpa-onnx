#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "audio/AudioTimeline.h"
#include "core/PacketSource.h"
#include "core/Timeline.h"

namespace sherpa_onnx {
namespace video {

class FfmpegDemuxer : public PacketSource {
 public:
  FfmpegDemuxer();
  ~FfmpegDemuxer() override;

  Status Open(const std::string& path);
  void Close();

  const VideoTrackInfo& track() const override { return track_; }
  int64_t sampleCount() const override { return timeline_.frameCount(); }
  bool frameCountExact() const override { return frameCountExact_; }
  IndexState indexState() const override { return indexState_; }
  Status GetSample(int64_t decodeIndex, SampleEntry* out) const override;
  Status ReadPacket(int64_t decodeIndex, EncodedPacket* out) override;

  const Timeline& timeline() const { return timeline_; }
  int64_t bytesReadDuringOpen() const { return openBytes_; }
  bool usesPread() const { return usesPread_; }

  bool hasAudio() const { return audio_.has_value(); }
  const AudioTrackInfo* audioTrack() const {
    return audio_ ? &*audio_ : nullptr;
  }
  const AudioTimeline& audioTimeline() const { return audioTimeline_; }
  Status ReadAudioPacket(int64_t index, EncodedPacket* out);

 private:
  Status BuildIndex();
  Status BuildAudioIndex();
  Status ReadMovByPread(int64_t decodeIndex, EncodedPacket* out);
  Status ReadMatroska(int64_t decodeIndex, EncodedPacket* out);
  Status ReadAudioMov(int64_t index, EncodedPacket* out);
  Status ReadAudioMatroska(int64_t index, EncodedPacket* out);
  Status EnsureAudioContext();

 public:
  struct Impl;

 private:
  std::unique_ptr<Impl> impl_;
  VideoTrackInfo track_;
  Timeline timeline_;
  std::optional<AudioTrackInfo> audio_;
  AudioTimeline audioTimeline_;
  bool frameCountExact_ = true;
  IndexState indexState_ = IndexState::Complete;
  int64_t openBytes_ = 0;
  bool usesPread_ = true;
  std::string path_;
};

}  // namespace video
}  // namespace sherpa_onnx
