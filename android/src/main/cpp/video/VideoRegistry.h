#pragma once

#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include "OfflineVideoEntry.h"
#include "VideoEntry.h"
#include "live/LiveVideoEntry.h"

namespace sherpa_onnx {
namespace video {

class VideoRegistry {
 public:
  static VideoRegistry& Instance();

  void SetCacheDir(std::string dir);
  const std::string& cacheDir() const { return cacheDir_; }
  void ConfigureRam(uint64_t totalRamBytes);

  Result<std::shared_ptr<OfflineVideoEntry>> CreateOfflineFromFile(
      const std::string& path);
  std::shared_ptr<OfflineVideoEntry> CreateOfflineFromPackets(
      std::unique_ptr<MemoryPacketSource> source);

  Result<std::shared_ptr<LiveVideoEntry>> CreateLive(
      const LiveVideoOptions& opts);

  std::shared_ptr<VideoEntry> Get(const std::string& id);
  std::shared_ptr<OfflineVideoEntry> GetOffline(const std::string& id);
  std::shared_ptr<LiveVideoEntry> GetLive(const std::string& id);

  bool Release(const std::string& id);
  void OnMemoryPressure(MemoryPressureLevel level);
  int SweepOrphans(int64_t maxAgeMs = 3'600'000);

  using EventFn = std::function<void(const std::string& type,
                                     const std::string& bufferId,
                                     const std::string& json)>;
  void SetEventSink(EventFn fn);
  void Emit(const std::string& type, const std::string& bufferId,
            const std::string& json);

 private:
  VideoRegistry() = default;
  mutable std::mutex mu_;
  std::unordered_map<std::string, std::shared_ptr<VideoEntry>> map_;
  std::string cacheDir_;
  EventFn events_;
};

}  // namespace video
}  // namespace sherpa_onnx
