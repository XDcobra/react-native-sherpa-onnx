#include "OfflineVideoEntry.h"

#include "VideoLog.h"
#include "core/Uuid.h"

namespace sherpa_onnx {
namespace video {

Result<std::shared_ptr<OfflineVideoEntry>> OfflineVideoEntry::OpenFile(
    const std::string& path, const std::string& cacheDir) {
  Result<std::shared_ptr<OfflineVideoEntry>> r;
  auto demux = std::make_unique<FfmpegDemuxer>();
  auto st = demux->Open(path);
  if (!st.ok) {
    r.status = st;
    return r;
  }
  auto e = std::make_shared<OfflineVideoEntry>();
  e->id_ = "vid_off_" + UuidV4();
  e->kind_ = VideoKind::Offline;
  e->openBytesRead_ = demux->bytesReadDuringOpen();
  e->cache_ = std::make_shared<DecodedFrameCache>();
  e->cache_->SetCacheDir(cacheDir);
  e->source_ = std::move(demux);
  r.value = std::move(e);
  VIDEO_LOGI("video.demux offline %s", r.value->id().c_str());
  return r;
}

std::shared_ptr<OfflineVideoEntry> OfflineVideoEntry::AdoptPackets(
    std::unique_ptr<MemoryPacketSource> source, const std::string& cacheDir) {
  auto e = std::make_shared<OfflineVideoEntry>();
  e->id_ = "vid_off_" + UuidV4();
  e->kind_ = VideoKind::Offline;
  e->cache_ = std::make_shared<DecodedFrameCache>();
  e->cache_->SetCacheDir(cacheDir);
  e->source_ = std::move(source);
  return e;
}

VideoBufferInfo OfflineVideoEntry::Info() const {
  VideoBufferInfo i;
  i.bufferId = id_;
  i.kind = VideoKind::Offline;
  i.state = VideoBufferState::Immutable;
  i.storageKind = VideoStorageKind::Container;
  if (source_) {
    i.track = source_->track();
    i.frameCount = source_->sampleCount();
    i.frameCountExact = source_->frameCountExact();
    i.indexState = source_->indexState();
  }
  if (timeline()) {
    i.seekableRange.startUs = timeline()->startUs();
    i.seekableRange.endUs = timeline()->endUs();
  }
  return i;
}

PacketSource* OfflineVideoEntry::packets() { return source_.get(); }

const Timeline* OfflineVideoEntry::timeline() const {
  if (auto* d = dynamic_cast<FfmpegDemuxer*>(source_.get())) {
    return &d->timeline();
  }
  if (auto* m = dynamic_cast<MemoryPacketSource*>(source_.get())) {
    return &m->timeline();
  }
  return nullptr;
}

}  // namespace video
}  // namespace sherpa_onnx
