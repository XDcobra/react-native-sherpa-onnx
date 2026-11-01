#include "LiveImageEntry.h"

#include "../decode/ImageDecodeBackend.h"
#include "../decode/ImageDecoder.h"

#include <algorithm>
#include <cstdint>

namespace sherpa_onnx {
namespace image {

namespace {

int ClampRingFrames(int n) {
  if (n <= 0) return 16;
  if (n < 1) return 1;
  if (n > 256) return 256;
  return n;
}

int ClampHot(int n) {
  if (n <= 0) return 8;
  if (n < 1) return 1;
  if (n > 32) return 32;
  return n;
}

}  // namespace

LiveImageEntry::LiveImageEntry(LiveImageOptions opts, std::string id)
    : id_(std::move(id)),
      opts_(opts),
      ring_limit_(ClampRingFrames(opts.ringFrames)),
      hot_limit_(ClampHot(opts.decode.hotFrames)) {}

std::shared_ptr<LiveImageEntry> LiveImageEntry::Create(
    const LiveImageOptions& opts, const std::string& bufferId) {
  return std::shared_ptr<LiveImageEntry>(new LiveImageEntry(opts, bufferId));
}

LiveImageEntry::Status LiveImageEntry::AppendCompressed(std::vector<uint8_t> bytes) {
  Status s;
  if (bytes.empty()) {
    s.errorCode = "ERR_IMAGE_INVALID_ARGUMENT";
    s.errorMessage = "empty compressed frame";
    return s;
  }
  std::lock_guard<std::mutex> lock(mu_);
  if (state_ != ImageBufferState::Recording) {
    s.errorCode = "ERR_IMAGE_INVALID_STATE";
    s.errorMessage = "append after finish rejected";
    return s;
  }
  CompressedImageFrame frame;
  frame.index = total_written_;
  frame.bytes = std::move(bytes);
  if (opts_.retention == ImageRetention::Session) {
    spool_.push_back(frame);
  }
  ring_.push_back(std::move(frame));
  total_written_ += 1;
  while (static_cast<int>(ring_.size()) > ring_limit_) {
    ring_.pop_front();
    evicted_ += 1;
  }
  s.ok = true;
  return s;
}

LiveImageEntry::Status LiveImageEntry::Finish() {
  Status s;
  std::lock_guard<std::mutex> lock(mu_);
  if (state_ != ImageBufferState::Recording) {
    s.errorCode = "ERR_IMAGE_INVALID_STATE";
    s.errorMessage = "finish requires recording state";
    return s;
  }
  state_ = ImageBufferState::Finished;
  s.ok = true;
  return s;
}

ImageBufferState LiveImageEntry::state() const {
  std::lock_guard<std::mutex> lock(mu_);
  return state_;
}

ImageBufferInfo LiveImageEntry::Info() const {
  std::lock_guard<std::mutex> lock(mu_);
  ImageBufferInfo info;
  info.bufferId = id_;
  info.kind = ImageBufferKind::Live;
  info.state = state_;
  info.storageKind = ImageStorageKind::Ram;
  info.totalFramesWritten = total_written_;
  info.ringEvictedFrames = evicted_;
  info.hasActiveSpool = opts_.retention == ImageRetention::Session;
  if (opts_.retention == ImageRetention::Session) {
    info.frameCount = static_cast<int>(spool_.size());
  } else {
    info.frameCount = static_cast<int>(ring_.size());
  }
  return info;
}

const CompressedImageFrame* LiveImageEntry::FindCompressedLocked(
    int64_t index) const {
  if (opts_.retention == ImageRetention::Session) {
    if (index < 0 || index >= static_cast<int64_t>(spool_.size())) return nullptr;
    return &spool_[static_cast<size_t>(index)];
  }
  for (const auto& f : ring_) {
    if (f.index == index) return &f;
  }
  return nullptr;
}

LiveImageEntry::Status LiveImageEntry::MaterializeLocked(int64_t index,
                                                         ImageFrameInfo* out) {
  Status s;
  auto hotIt = hot_.find(index);
  if (hotIt != hot_.end()) {
    lru_clock_ += 1;
    hotIt->second.lru_tick = lru_clock_;
    if (out) {
      out->index = static_cast<int>(index);
      out->width = hotIt->second.frame.width;
      out->height = hotIt->second.frame.height;
      out->byteSize = static_cast<int64_t>(hotIt->second.frame.byteSize());
      out->storageKind = ImageStorageKind::Ram;
    }
    s.ok = true;
    return s;
  }

  const CompressedImageFrame* src = FindCompressedLocked(index);
  if (!src) {
    s.errorCode = "ERR_IMAGE_FRAME_EVICTED";
    s.errorMessage = "live frame not in ring or spool";
    return s;
  }

  DecodeResult decoded =
      DecodeWithPolicy(src->bytes.data(), src->bytes.size(), opts_.decode,
                       id_);
  decode_count_.fetch_add(1);
  if (!decoded.ok) {
    s.errorCode = decoded.errorCode.empty() ? "ERR_IMAGE_DECODE_FAILED"
                                            : decoded.errorCode;
    s.errorMessage = decoded.errorMessage;
    return s;
  }

  HotRgb hot;
  hot.frame = std::move(decoded.frame);
  lru_clock_ += 1;
  hot.lru_tick = lru_clock_;
  if (out) {
    out->index = static_cast<int>(index);
    out->width = hot.frame.width;
    out->height = hot.frame.height;
    out->byteSize = static_cast<int64_t>(hot.frame.byteSize());
    out->storageKind = ImageStorageKind::Ram;
    out->decoderProvider = decoded.codecProvider;
    out->decoderTier = decoded.codecTier;
    out->decoderOrigin = decoded.codecOrigin;
  }
  hot_[index] = std::move(hot);
  while (static_cast<int>(hot_.size()) > hot_limit_) {
    int64_t victim = -1;
    uint64_t oldest = UINT64_MAX;
    for (const auto& kv : hot_) {
      if (kv.second.lru_tick < oldest) {
        oldest = kv.second.lru_tick;
        victim = kv.first;
      }
    }
    if (victim < 0) break;
    hot_.erase(victim);
  }
  s.ok = true;
  return s;
}

LiveImageEntry::Status LiveImageEntry::EnsureFrame(int frameIndex,
                                                   ImageFrameInfo* out) {
  Status s;
  std::lock_guard<std::mutex> lock(mu_);
  if (state_ == ImageBufferState::Recording) {
    s.errorCode = "ERR_IMAGE_INVALID_STATE";
    s.errorMessage = "ensure/OCR requires finished live image buffer";
    return s;
  }
  if (frameIndex < 0) {
    s.errorCode = "ERR_IMAGE_INVALID_ARGUMENT";
    s.errorMessage = "frameIndex out of range";
    return s;
  }
  return MaterializeLocked(frameIndex, out);
}

const uint8_t* LiveImageEntry::GetFrameRgbPtr(int frameIndex, int* outWidth,
                                              int* outHeight) {
  std::lock_guard<std::mutex> lock(mu_);
  if (state_ == ImageBufferState::Recording) return nullptr;
  if (frameIndex < 0) return nullptr;
  ImageFrameInfo info;
  auto st = MaterializeLocked(frameIndex, &info);
  if (!st.ok) return nullptr;
  auto it = hot_.find(frameIndex);
  if (it == hot_.end() || !it->second.frame.valid()) return nullptr;
  if (outWidth) *outWidth = it->second.frame.width;
  if (outHeight) *outHeight = it->second.frame.height;
  return it->second.frame.rgb.data();
}

bool LiveImageEntry::GetFrameInfo(int frameIndex, ImageFrameInfo* out) const {
  std::lock_guard<std::mutex> lock(mu_);
  if (!out) return false;
  const CompressedImageFrame* src = FindCompressedLocked(frameIndex);
  if (!src) return false;
  out->index = frameIndex;
  auto hotIt = hot_.find(frameIndex);
  if (hotIt != hot_.end()) {
    out->width = hotIt->second.frame.width;
    out->height = hotIt->second.frame.height;
    out->byteSize = static_cast<int64_t>(hotIt->second.frame.byteSize());
  } else {
    out->width = 0;
    out->height = 0;
    out->byteSize = 0;
  }
  out->storageKind = ImageStorageKind::Ram;
  return true;
}

}  // namespace image
}  // namespace sherpa_onnx
