#pragma once

#include "ImageMmapThreshold.h"
#include "ImageTypes.h"
#include "decode/ImageDecoder.h"

#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace sherpa_onnx {

namespace pdf {
class PdfLazyBackend;
}  // namespace pdf

namespace image {

/**
 * Offline ImageBuffer registry (C++ source of truth).
 * Buffer ids: img_off_<uuid>. Per-frame backing: RAM or mmap (.rgb8 temp file).
 * Lazy-lru PDF buffers: placeholder slots + retained PdfLazyBackend; at most
 * hotFrames hold decoded RGB.
 */
class ImageRegistry {
 public:
  using ProgressFn = std::function<void(int done, int total, const std::string& phase)>;
  using CancelFn = std::function<bool()>;

  static ImageRegistry& Instance();

  /** Configure mmap threshold inputs (call once from platform init). */
  void ConfigureThreshold(ImageThresholdPlatform platform, uint64_t totalRamBytes);

  /** Cache directory for mmap temp files (required before FileOrigin mmap). */
  void SetCacheDir(const std::string& cacheDir);

  std::string CreateEmpty();

  /**
   * Decode files into a new buffer. pathOrigin=FileOrigin for threshold.
   * On cancel: releases partial buffer and returns empty string + error.
   */
  struct CreateResult {
    bool ok = false;
    std::string bufferId;
    std::string errorCode;
    std::string errorMessage;
    ImageBufferInfo info;
  };

  CreateResult CreateFromFiles(const std::vector<std::string>& paths,
                               const DecodeOptions& opts,
                               ProgressFn progress = {},
                               CancelFn cancel = {});

  CreateResult CreateFromBytesList(const std::vector<std::vector<uint8_t>>& blobs,
                                   const DecodeOptions& opts,
                                   ImageThresholdPathType pathType,
                                   ProgressFn progress = {},
                                   CancelFn cancel = {});

  /** Adopt a pre-decoded RGB8 frame (e.g. HEIC platform path) into a new or existing buffer. */
  bool AppendRgbFrame(const std::string& bufferId, RgbFrame frame,
                      ImageThresholdPathType pathType = ImageThresholdPathType::HeapOrigin);

  CreateResult CreateFromRgbFrames(std::vector<RgbFrame> frames,
                                   ImageThresholdPathType pathType);

  /**
   * Create a lazy-lru PDF buffer: frameCount placeholders (cold), retain session.
   * pages_1based empty = all document pages. hotFrames clamped to 1..32.
   */
  CreateResult CreateLazyPdfSlots(
      std::unique_ptr<pdf::PdfLazyBackend> backend,
      const std::vector<int>& pages_1based,
      int hotFrames);

  struct EnsureResult {
    bool ok = false;
    std::string errorCode;
    std::string errorMessage;
    ImageFrameInfo info;
  };

  /**
   * Ensure frame RGB is resident (rasterize if cold lazy slot).
   * Updates LRU; may evict coldest hot frame; schedules ±1 prefetch.
   * No-op success for already-hot / non-lazy frames (returns frame info).
   */
  EnsureResult EnsureFrame(const std::string& bufferId, int frameIndex);

  /** Drop RGB for a hot frame; keep pageNumber/dpi metadata. */
  bool EvictFrame(const std::string& bufferId, int frameIndex);

  bool GetInfo(const std::string& bufferId, ImageBufferInfo& out) const;
  bool GetFrameInfo(const std::string& bufferId, int frameIndex,
                    ImageFrameInfo& out) const;

  /**
   * Zero-copy RGB pointer for OCR (mmap or RAM). Valid until Release/evict.
   * On cold lazy frames: sync EnsureFrame first.
   */
  const uint8_t* GetFrameRgbPtr(const std::string& bufferId, int frameIndex,
                                int* outWidth, int* outHeight);

  bool Release(const std::string& bufferId);

  /** Startup orphan sweep: prefix img_off_, suffix .rgb8, older than maxAgeMs. */
  int SweepOrphanedTempFiles(int64_t maxAgeMs = 3'600'000);

  /** Re-evaluate threshold after appends (post-adopt upgrade). */
  void MaybeUpgradeToMmap(const std::string& bufferId, ImageThresholdPathType pathType);

 private:
  ImageRegistry() = default;

  struct MmapFrame {
    std::string path;
    void* addr = nullptr;  // MAP_FAILED / nullptr when unmapped
    size_t length = 0;
    int width = 0;
    int height = 0;

    bool valid() const;
    const uint8_t* rgbPtr() const;
    void unmap();
    void unlinkFile();
  };

  struct Frame {
    int width = 0;
    int height = 0;
    ImageStorageKind kind = ImageStorageKind::Ram;
    std::vector<uint8_t> ram;  // empty when mmap or cold
    MmapFrame mmap;
    int pageNumber = 0;
    int dpi = 0;
    int sectionIndex = -1;
    std::string href;
    uint64_t lruTick = 0;
  };

  struct Entry {
    std::string bufferId;
    std::vector<Frame> frames;
    ImageThresholdPathType pathType = ImageThresholdPathType::HeapOrigin;
    ImageBufferState state = ImageBufferState::Immutable;
    int hotFramesLimit = 0;
    uint64_t lruClock = 0;
    uint64_t generation = 0;
    std::unique_ptr<pdf::PdfLazyBackend> pdfLazy;

    Entry();
    ~Entry();
    Entry(Entry&&) noexcept;
    Entry& operator=(Entry&&) noexcept;
    Entry(const Entry&) = delete;
    Entry& operator=(const Entry&) = delete;

    int64_t totalBytes() const;
    ImageStorageKind storageKind() const;
    int hotCount() const;
    bool isHot(size_t index) const;
  };

  mutable std::mutex mu_;
  std::unordered_map<std::string, Entry> entries_;
  std::string cacheDir_;
  ImageThresholdPlatform platform_ = ImageThresholdPlatform::Android;
  ImageRamClass ramClass_ = ImageRamClass::Mid;
  bool thresholdConfigured_ = false;

  std::string NewBufferId();
  int64_t ThresholdFor(ImageThresholdPathType pathType) const;
  bool WriteFrameToMmap(Frame& frame, const std::string& bufferId, int frameIndex);
  bool UpgradeEntryLocked(Entry& entry);
  CreateResult FinishCreateLocked(Entry entry);
  void ClearFrameRgbLocked(Frame& frame);
  void TouchLruLocked(Entry& entry, int frameIndex);
  void EvictUntilUnderLimitLocked(Entry& entry);
  void FillFrameInfoLocked(const Frame& f, int frameIndex, ImageFrameInfo& out) const;
  void ScheduleNeighborPrefetch(const std::string& bufferId, int frameIndex,
                                uint64_t generation, int frameCount);
};

}  // namespace image
}  // namespace sherpa_onnx
