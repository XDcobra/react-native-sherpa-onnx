#pragma once

#include <memory>
#include <string>

#include "VideoEntry.h"
#include "decode/MemoryPacketSource.h"
#include "demux/FfmpegDemuxer.h"

namespace sherpa_onnx {
namespace video {

class OfflineVideoEntry : public VideoEntry {
 public:
  static Result<std::shared_ptr<OfflineVideoEntry>> OpenFile(
      const std::string& path, const std::string& cacheDir);
  static std::shared_ptr<OfflineVideoEntry> AdoptPackets(
      std::unique_ptr<MemoryPacketSource> source, const std::string& cacheDir);

  VideoBufferInfo Info() const override;
  PacketSource* packets() override;
  const Timeline* timeline() const override;
  std::shared_ptr<DecodedFrameCache> cache() override { return cache_; }
  VideoBufferState state() const override { return VideoBufferState::Immutable; }

  int64_t openBytesRead() const { return openBytesRead_; }

 private:
  std::unique_ptr<PacketSource> source_;
  int64_t openBytesRead_ = 0;
};

}  // namespace video
}  // namespace sherpa_onnx
