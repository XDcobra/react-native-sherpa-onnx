#include "VideoRegistry.h"

#include "VideoLog.h"
#include "core/MemoryBudget.h"

#include <chrono>
#include <filesystem>

namespace sherpa_onnx {
namespace video {

VideoRegistry& VideoRegistry::Instance() {
  static VideoRegistry inst;
  return inst;
}

void VideoRegistry::SetCacheDir(std::string dir) {
  std::lock_guard<std::mutex> lock(mu_);
  cacheDir_ = std::move(dir);
  std::error_code ec;
  std::filesystem::create_directories(cacheDir_, ec);
}

void VideoRegistry::ConfigureRam(uint64_t totalRamBytes) {
  MemoryBudget::Instance().Configure(MemoryBudget::ClassifyRam(totalRamBytes));
}

void VideoRegistry::SetEventSink(EventFn fn) {
  std::lock_guard<std::mutex> lock(mu_);
  events_ = std::move(fn);
}

void VideoRegistry::Emit(const std::string& type, const std::string& bufferId,
                         const std::string& json) {
  EventFn fn;
  {
    std::lock_guard<std::mutex> lock(mu_);
    fn = events_;
  }
  if (fn) {
    fn(type, bufferId, json);
  }
}

Result<std::shared_ptr<OfflineVideoEntry>> VideoRegistry::CreateOfflineFromFile(
    const std::string& path) {
  auto opened = OfflineVideoEntry::OpenFile(path, cacheDir_);
  if (!opened.ok()) {
    return opened;
  }
  std::lock_guard<std::mutex> lock(mu_);
  map_[opened.value->id()] = opened.value;
  return opened;
}

std::shared_ptr<OfflineVideoEntry> VideoRegistry::CreateOfflineFromPackets(
    std::unique_ptr<MemoryPacketSource> source) {
  auto e = OfflineVideoEntry::AdoptPackets(std::move(source), cacheDir_);
  std::lock_guard<std::mutex> lock(mu_);
  map_[e->id()] = e;
  return e;
}

Result<std::shared_ptr<LiveVideoEntry>> VideoRegistry::CreateLive(
    const LiveVideoOptions& opts) {
  Result<std::shared_ptr<LiveVideoEntry>> r;
  auto e = LiveVideoEntry::Create(opts, cacheDir_);
  std::lock_guard<std::mutex> lock(mu_);
  map_[e->id()] = e;
  r.value = e;
  return r;
}

std::shared_ptr<VideoEntry> VideoRegistry::Get(const std::string& id) {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = map_.find(id);
  return it == map_.end() ? nullptr : it->second;
}

std::shared_ptr<OfflineVideoEntry> VideoRegistry::GetOffline(
    const std::string& id) {
  return std::dynamic_pointer_cast<OfflineVideoEntry>(Get(id));
}

std::shared_ptr<LiveVideoEntry> VideoRegistry::GetLive(const std::string& id) {
  return std::dynamic_pointer_cast<LiveVideoEntry>(Get(id));
}

bool VideoRegistry::Release(const std::string& id) {
  std::shared_ptr<VideoEntry> e;
  {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = map_.find(id);
    if (it == map_.end()) {
      return false;
    }
    e = it->second;
    map_.erase(it);
  }
  if (e) {
    e->BumpGeneration();
    e->DropStickySession();
  }
  VIDEO_LOGI("video.registry release %s", id.c_str());
  return true;
}

void VideoRegistry::OnMemoryPressure(MemoryPressureLevel level) {
  std::vector<std::shared_ptr<VideoEntry>> entries;
  {
    std::lock_guard<std::mutex> lock(mu_);
    for (auto& kv : map_) {
      entries.push_back(kv.second);
    }
  }
  for (auto& e : entries) {
    e->OnMemoryPressure(level);
    if (auto live = std::dynamic_pointer_cast<LiveVideoEntry>(e)) {
      if (live->spool().active()) {
        live->ring().TrimToNewestGop();
      }
    }
  }
}

int VideoRegistry::SweepOrphans(int64_t maxAgeMs) {
  if (cacheDir_.empty()) {
    return 0;
  }
  int n = 0;
  const auto now = std::filesystem::file_time_type::clock::now();
  std::error_code ec;
  for (auto it = std::filesystem::directory_iterator(cacheDir_, ec);
       it != std::filesystem::directory_iterator(); ++it) {
    const auto name = it->path().filename().string();
    if (name.rfind("vid_", 0) != 0) {
      continue;
    }
    auto ftime = std::filesystem::last_write_time(it->path(), ec);
    if (ec) {
      continue;
    }
    const auto age = std::chrono::duration_cast<std::chrono::milliseconds>(
                         now - ftime)
                         .count();
    if (age > maxAgeMs) {
      std::filesystem::remove(it->path(), ec);
      ++n;
    }
  }
  VIDEO_LOGI("video.registry sweep orphans=%d", n);
  return n;
}

}  // namespace video
}  // namespace sherpa_onnx
