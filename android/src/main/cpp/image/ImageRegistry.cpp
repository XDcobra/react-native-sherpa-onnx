#include "ImageRegistry.h"

#include "decode/ImageDecodeBackend.h"
#include "encode/ImageEncodeBackend.h"
#include "ImageFileLazyBackend.h"
#include "PdfLazyBackend.h"
#include "live/LiveImageEntry.h"

#include <chrono>
#include <climits>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <random>
#include <sstream>
#include <thread>

#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include <ctime>

#if defined(__ANDROID__)
#include <android/log.h>
#define IMG_LOGI(...) \
  __android_log_print(ANDROID_LOG_INFO, "SherpaOnnx:image", __VA_ARGS__)
#define IMG_LOGW(...) \
  __android_log_print(ANDROID_LOG_WARN, "SherpaOnnx:image", __VA_ARGS__)
#define PDF_LAZY_LOGI(...) \
  __android_log_print(ANDROID_LOG_INFO, "SherpaOnnx:pdf.lazy", __VA_ARGS__)
#else
#define IMG_LOGI(...) \
  do {                \
  } while (0)
#define IMG_LOGW(...) \
  do {                \
  } while (0)
#define PDF_LAZY_LOGI(...) \
  do {                     \
  } while (0)
#endif

namespace sherpa_onnx {
namespace image {

namespace fs = std::filesystem;

namespace {

constexpr int kHotFramesDefault = 8;
constexpr int kHotFramesMin = 1;
constexpr int kHotFramesMax = 32;

std::string FormatUuidV4() {
  static thread_local std::mt19937_64 rng{std::random_device{}()};
  std::uniform_int_distribution<uint64_t> dist;
  const uint64_t a = dist(rng);
  const uint64_t b = dist(rng);
  char buf[37];
  std::snprintf(
      buf, sizeof(buf),
      "%08x-%04x-%04x-%04x-%012llx",
      static_cast<unsigned>(a & 0xffffffffu),
      static_cast<unsigned>((a >> 32) & 0xffffu),
      static_cast<unsigned>(0x4000u | ((a >> 48) & 0x0fffu)),
      static_cast<unsigned>(0x8000u | ((b >> 48) & 0x3fffu)),
      static_cast<unsigned long long>(b & 0xffffffffffffull));
  return buf;
}

int ClampHotFrames(int hotFrames) {
  if (hotFrames <= 0) return kHotFramesDefault;
  if (hotFrames < kHotFramesMin) return kHotFramesMin;
  if (hotFrames > kHotFramesMax) return kHotFramesMax;
  return hotFrames;
}

}  // namespace

bool ImageRegistry::MmapFrame::valid() const {
  return addr != nullptr && addr != MAP_FAILED && length > 0 && width > 0 && height > 0;
}

const uint8_t* ImageRegistry::MmapFrame::rgbPtr() const {
  return valid() ? static_cast<const uint8_t*>(addr) : nullptr;
}

void ImageRegistry::MmapFrame::unmap() {
  if (addr != nullptr && addr != MAP_FAILED) {
    munmap(addr, length);
  }
  addr = nullptr;
  length = 0;
}

void ImageRegistry::MmapFrame::unlinkFile() {
  if (!path.empty()) {
    ::unlink(path.c_str());
    path.clear();
  }
}

ImageRegistry::Entry::Entry() = default;
ImageRegistry::Entry::~Entry() = default;
ImageRegistry::Entry::Entry(Entry&&) noexcept = default;
ImageRegistry::Entry& ImageRegistry::Entry::operator=(Entry&&) noexcept = default;

bool ImageRegistry::Entry::isHot(size_t index) const {
  if (index >= frames.size()) return false;
  const auto& f = frames[index];
  if (f.width <= 0 || f.height <= 0) return false;
  if (f.kind == ImageStorageKind::Mmap) return f.mmap.valid();
  return f.ram.size() ==
         static_cast<size_t>(f.width) * static_cast<size_t>(f.height) * 3u;
}

int ImageRegistry::Entry::hotCount() const {
  int n = 0;
  for (size_t i = 0; i < frames.size(); ++i) {
    if (isHot(i)) ++n;
  }
  return n;
}

int64_t ImageRegistry::Entry::totalBytes() const {
  int64_t sum = 0;
  for (size_t i = 0; i < frames.size(); ++i) {
    if (!isHot(i)) continue;
    const auto& f = frames[i];
    sum += static_cast<int64_t>(f.width) * static_cast<int64_t>(f.height) * 3;
  }
  return sum;
}

ImageStorageKind ImageRegistry::Entry::storageKind() const {
  if (frames.empty()) return ImageStorageKind::Ram;
  bool anyHot = false;
  for (size_t i = 0; i < frames.size(); ++i) {
    if (!isHot(i)) continue;
    anyHot = true;
    if (frames[i].kind == ImageStorageKind::Ram) return ImageStorageKind::Ram;
  }
  return anyHot ? ImageStorageKind::Mmap : ImageStorageKind::Ram;
}

ImageRegistry& ImageRegistry::Instance() {
  static ImageRegistry inst;
  return inst;
}

void ImageRegistry::ConfigureThreshold(ImageThresholdPlatform platform,
                                       uint64_t totalRamBytes) {
  std::lock_guard<std::mutex> lock(mu_);
  platform_ = platform;
  ramClass_ = ImageMmapThreshold::ClassifyRam(totalRamBytes);
  thresholdConfigured_ = true;
  IMG_LOGI("[SherpaOnnx:image] mmap threshold policy: platform=%s ramClass=%s "
           "fileOrigin=%lld heapOrigin=%lld",
           platform == ImageThresholdPlatform::Android ? "android" : "ios",
           ImageMmapThreshold::RamClassName(ramClass_),
           static_cast<long long>(ImageMmapThreshold::ThresholdBytes(
               platform_, ramClass_, ImageThresholdPathType::FileOrigin)),
           static_cast<long long>(ImageMmapThreshold::ThresholdBytes(
               platform_, ramClass_, ImageThresholdPathType::HeapOrigin)));
}

void ImageRegistry::SetCacheDir(const std::string& cacheDir) {
  std::lock_guard<std::mutex> lock(mu_);
  cacheDir_ = cacheDir;
  RegisterPortableImageProviders();
  RegisterPlatformImageProviders();
  RegisterPortableImageEncodeProviders();
  RegisterPlatformImageEncodeProviders();
}

std::string ImageRegistry::NewBufferId() {
  return "img_off_" + FormatUuidV4();
}

std::string ImageRegistry::NewLiveBufferId() {
  return "img_live_" + FormatUuidV4();
}

int64_t ImageRegistry::ThresholdFor(ImageThresholdPathType pathType) const {
  const ImageRamClass rc =
      thresholdConfigured_ ? ramClass_ : ImageRamClass::Mid;
  return ImageMmapThreshold::ThresholdBytes(platform_, rc, pathType);
}

void ImageRegistry::ClearFrameRgbLocked(Frame& frame) {
  if (frame.kind == ImageStorageKind::Mmap) {
    frame.mmap.unmap();
    frame.mmap.unlinkFile();
  }
  frame.ram.clear();
  frame.ram.shrink_to_fit();
  frame.width = 0;
  frame.height = 0;
  frame.kind = ImageStorageKind::Ram;
  frame.lruTick = 0;
}

void ImageRegistry::FillFrameInfoLocked(const Frame& f, int frameIndex,
                                        ImageFrameInfo& out) const {
  out.index = frameIndex;
  out.width = f.width;
  out.height = f.height;
  out.expectedWidth = f.width > 0 ? f.width : f.expectedWidth;
  out.expectedHeight = f.height > 0 ? f.height : f.expectedHeight;
  out.byteSize = static_cast<int64_t>(f.width) * static_cast<int64_t>(f.height) * 3;
  out.storageKind = f.kind;
  out.pageNumber = f.pageNumber;
  out.dpi = f.dpi;
  out.sectionIndex = f.sectionIndex;
  out.href = f.href;
  out.sourceVideoBufferId = f.sourceVideoBufferId;
  out.sourcePtsUs = f.sourcePtsUs;
  out.sourceFrameIndex = f.sourceFrameIndex;
  out.decoderProvider = f.decoderProvider;
  out.decoderTier = f.decoderTier;
  out.decoderOrigin = f.decoderOrigin;
}

bool ImageRegistry::WriteFrameToMmap(Frame& frame, const std::string& bufferId,
                                     int frameIndex) {
  if (cacheDir_.empty()) return false;
  if (frame.ram.empty() || frame.width <= 0 || frame.height <= 0) return false;

  // File name: img_off_<uuid>_f<N>.rgb8 (strip leading img_off_ from bufferId).
  std::string idPart = bufferId;
  constexpr const char* kPrefix = "img_off_";
  if (idPart.rfind(kPrefix, 0) == 0) {
    idPart = idPart.substr(std::strlen(kPrefix));
  }
  std::ostringstream oss;
  oss << cacheDir_ << "/img_off_" << idPart << "_f" << frameIndex << ".rgb8";
  const std::string path = oss.str();

  const size_t bytes =
      static_cast<size_t>(frame.width) * static_cast<size_t>(frame.height) * 3u;
  int fd = ::open(path.c_str(), O_RDWR | O_CREAT | O_TRUNC, 0600);
  if (fd < 0) return false;

  if (::ftruncate(fd, static_cast<off_t>(bytes)) != 0) {
    ::close(fd);
    ::unlink(path.c_str());
    return false;
  }

  void* mapped = ::mmap(nullptr, bytes, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (mapped == MAP_FAILED) {
    ::close(fd);
    ::unlink(path.c_str());
    return false;
  }
  std::memcpy(mapped, frame.ram.data(), bytes);
  ::msync(mapped, bytes, MS_SYNC);
  // Remap read-only for consumers
  ::munmap(mapped, bytes);
  ::close(fd);

  fd = ::open(path.c_str(), O_RDONLY);
  if (fd < 0) {
    ::unlink(path.c_str());
    return false;
  }
  mapped = ::mmap(nullptr, bytes, PROT_READ, MAP_PRIVATE, fd, 0);
  ::close(fd);
  if (mapped == MAP_FAILED) {
    ::unlink(path.c_str());
    return false;
  }

  frame.mmap.path = path;
  frame.mmap.addr = mapped;
  frame.mmap.length = bytes;
  frame.mmap.width = frame.width;
  frame.mmap.height = frame.height;
  frame.kind = ImageStorageKind::Mmap;
  frame.ram.clear();
  frame.ram.shrink_to_fit();
  return true;
}

bool ImageRegistry::UpgradeEntryLocked(Entry& entry) {
  const int64_t threshold = ThresholdFor(entry.pathType);
  if (entry.totalBytes() < threshold) return false;
  if (cacheDir_.empty()) {
    IMG_LOGW("[SherpaOnnx:image] mmap upgrade skipped: no cacheDir bufferId=%s",
             entry.bufferId.c_str());
    return false;
  }

  bool any = false;
  for (size_t i = 0; i < entry.frames.size(); ++i) {
    auto& f = entry.frames[i];
    if (f.kind == ImageStorageKind::Ram && !f.ram.empty() && f.pins == 0) {
      if (WriteFrameToMmap(f, entry.bufferId, static_cast<int>(i))) {
        any = true;
      } else {
        IMG_LOGW("[SherpaOnnx:image] mmap frame write failed bufferId=%s frame=%zu",
                 entry.bufferId.c_str(), i);
      }
    }
  }
  if (any) {
    IMG_LOGI("[SherpaOnnx:image] mmap upgrade bufferId=%s totalBytes=%lld threshold=%lld "
             "storage=%s",
             entry.bufferId.c_str(), static_cast<long long>(entry.totalBytes()),
             static_cast<long long>(threshold), StorageKindName(entry.storageKind()));
  }
  return any;
}

ImageRegistry::CreateResult ImageRegistry::FinishCreateLocked(Entry entry) {
  CreateResult r;
  UpgradeEntryLocked(entry);
  r.info.bufferId = entry.bufferId;
  r.info.frameCount = static_cast<int>(entry.frames.size());
  r.info.totalBytes = entry.totalBytes();
  r.info.storageKind = entry.storageKind();
  r.info.state = entry.state;
  r.bufferId = entry.bufferId;
  r.ok = true;
  entries_[entry.bufferId] = std::move(entry);
  return r;
}

std::string ImageRegistry::CreateEmpty() {
  std::lock_guard<std::mutex> lock(mu_);
  Entry e;
  e.bufferId = NewBufferId();
  e.pathType = ImageThresholdPathType::HeapOrigin;
  const std::string id = e.bufferId;
  entries_[id] = std::move(e);
  IMG_LOGI("[SherpaOnnx:image] createEmpty bufferId=%s", id.c_str());
  return id;
}

bool ImageRegistry::AppendRgbFrame(const std::string& bufferId, RgbFrame frame,
                                   ImageThresholdPathType pathType) {
  if (!frame.valid()) return false;
  std::lock_guard<std::mutex> lock(mu_);
  auto it = entries_.find(bufferId);
  if (it == entries_.end()) return false;
  if (it->second.state == ImageBufferState::Lazy) return false;
  Frame f;
  f.width = frame.width;
  f.height = frame.height;
  f.kind = ImageStorageKind::Ram;
  f.ram = std::move(frame.rgb);
  f.pageNumber = frame.pageNumber;
  f.dpi = frame.dpi;
  f.sectionIndex = frame.sectionIndex;
  f.href = frame.href;
  f.sourceVideoBufferId = frame.sourceVideoBufferId;
  f.sourcePtsUs = frame.sourcePtsUs;
  f.sourceFrameIndex = frame.sourceFrameIndex;
  it->second.pathType = pathType;
  it->second.frames.push_back(std::move(f));
  UpgradeEntryLocked(it->second);
  return true;
}

ImageRegistry::CreateResult ImageRegistry::CreateFromRgbFrames(
    std::vector<RgbFrame> frames, ImageThresholdPathType pathType) {
  CreateResult r;
  if (frames.empty()) {
    r.errorCode = "ERR_IMAGE_INVALID_ARGUMENT";
    r.errorMessage = "no frames";
    return r;
  }
  std::lock_guard<std::mutex> lock(mu_);
  Entry e;
  e.bufferId = NewBufferId();
  e.pathType = pathType;
  e.state = ImageBufferState::Immutable;
  for (auto& rf : frames) {
    if (!rf.valid()) {
      r.errorCode = "ERR_IMAGE_DECODE_FAILED";
      r.errorMessage = "invalid RGB frame";
      return r;
    }
    Frame f;
    f.width = rf.width;
    f.height = rf.height;
    f.kind = ImageStorageKind::Ram;
    f.ram = std::move(rf.rgb);
    f.pageNumber = rf.pageNumber;
    f.dpi = rf.dpi;
    f.sectionIndex = rf.sectionIndex;
    f.href = rf.href;
    e.frames.push_back(std::move(f));
  }
  return FinishCreateLocked(std::move(e));
}

ImageRegistry::CreateResult ImageRegistry::CreateLazyPdfSlots(
    std::unique_ptr<pdf::PdfLazyBackend> backend,
    const std::vector<int>& pages_1based,
    int hotFrames) {
  CreateResult r;
  if (!backend) {
    r.errorCode = "ERR_PDF_INTERNAL";
    r.errorMessage = "PdfLazyBackend required";
    return r;
  }

  const int page_count = backend->page_count();
  const int dpi = backend->dpi();
  std::vector<int> pages = pages_1based;
  if (pages.empty()) {
    pages.reserve(static_cast<size_t>(page_count));
    for (int p = 1; p <= page_count; ++p) {
      pages.push_back(p);
    }
  }
  for (int p : pages) {
    if (p < 1 || p > page_count) {
      r.errorCode = "ERR_PDF_INVALID_ARGUMENT";
      r.errorMessage = "page index out of range (1-based)";
      return r;
    }
  }
  if (pages.empty()) {
    r.errorCode = "ERR_PDF_INVALID_ARGUMENT";
    r.errorMessage = "no pages to rasterize";
    return r;
  }

  const int limit = ClampHotFrames(hotFrames);

  std::lock_guard<std::mutex> lock(mu_);
  Entry e;
  e.bufferId = NewBufferId();
  e.pathType = ImageThresholdPathType::FileOrigin;
  e.state = ImageBufferState::Lazy;
  e.hotFramesLimit = limit;
  e.frames.reserve(pages.size());
  for (int page : pages) {
    Frame f;
    f.pageNumber = page;
    f.dpi = dpi;
    // Page size without rendering, so viewers can lay out cold pages.
    backend->PageSize(page, &f.expectedWidth, &f.expectedHeight);
    e.frames.push_back(std::move(f));
  }
  e.pdfLazy = std::move(backend);

  PDF_LAZY_LOGI(
      "createLazy bufferId=%s frames=%zu hotFrames=%d pageCount=%d",
      e.bufferId.c_str(), e.frames.size(), limit, page_count);

  r.info.bufferId = e.bufferId;
  r.info.frameCount = static_cast<int>(e.frames.size());
  r.info.totalBytes = 0;
  r.info.storageKind = ImageStorageKind::Ram;
  r.info.state = ImageBufferState::Lazy;
  r.bufferId = e.bufferId;
  r.ok = true;
  entries_[e.bufferId] = std::move(e);
  return r;
}

void ImageRegistry::TouchLruLocked(Entry& entry, int frameIndex) {
  entry.lruClock += 1;
  entry.frames[static_cast<size_t>(frameIndex)].lruTick = entry.lruClock;
}

void ImageRegistry::EvictUntilUnderLimitLocked(Entry& entry) {
  if (entry.state != ImageBufferState::Lazy || entry.hotFramesLimit <= 0) return;
  while (entry.hotCount() > entry.hotFramesLimit) {
    int victim = -1;
    uint64_t oldest = UINT64_MAX;
    for (size_t i = 0; i < entry.frames.size(); ++i) {
      if (!entry.isHot(i) || entry.frames[i].pins > 0) continue;
      const uint64_t tick = entry.frames[i].lruTick;
      if (tick < oldest) {
        oldest = tick;
        victim = static_cast<int>(i);
      }
    }
    if (victim < 0) break;
    PDF_LAZY_LOGI(
        "evict bufferId=%s frame=%d hot=%d limit=%d", entry.bufferId.c_str(),
        victim, entry.hotCount(), entry.hotFramesLimit);
    ClearFrameRgbLocked(entry.frames[static_cast<size_t>(victim)]);
  }
}

void ImageRegistry::ScheduleNeighborPrefetch(const std::string& bufferId,
                                             int frameIndex, uint64_t generation,
                                             int frameCount) {
  constexpr size_t kMaxQueued = 8;  // newest requests win; old ones are stale
  {
    std::lock_guard<std::mutex> lock(prefetchMu_);
    for (int idx : {frameIndex + 1, frameIndex - 1}) {
      if (idx < 0 || idx >= frameCount) continue;
      bool queued = false;
      for (const auto& job : prefetchQueue_) {
        if (job.frameIndex == idx && job.bufferId == bufferId) {
          queued = true;
          break;
        }
      }
      if (queued) continue;
      prefetchQueue_.push_back(PrefetchJob{bufferId, idx, generation});
      while (prefetchQueue_.size() > kMaxQueued) prefetchQueue_.pop_front();
    }
    if (!prefetchWorkerStarted_) {
      prefetchWorkerStarted_ = true;
      std::thread([this]() { PrefetchWorkerLoop(); }).detach();
    }
  }
  prefetchCv_.notify_one();
}

void ImageRegistry::PrefetchWorkerLoop() {
  for (;;) {
    PrefetchJob job;
    {
      std::unique_lock<std::mutex> lock(prefetchMu_);
      prefetchCv_.wait(lock, [this]() { return !prefetchQueue_.empty(); });
      job = std::move(prefetchQueue_.back());  // most recent first
      prefetchQueue_.pop_back();
    }
    {
      std::lock_guard<std::mutex> lock(mu_);
      auto it = entries_.find(job.bufferId);
      if (it == entries_.end()) continue;
      if (it->second.generation != job.generation) continue;
      if (it->second.state != ImageBufferState::Lazy) continue;
      if (job.frameIndex < 0 ||
          job.frameIndex >= static_cast<int>(it->second.frames.size())) {
        continue;
      }
      if (it->second.isHot(static_cast<size_t>(job.frameIndex))) continue;
    }
    PDF_LAZY_LOGI("prefetch bufferId=%s frame=%d", job.bufferId.c_str(), job.frameIndex);
    (void)EnsureFrameNoPrefetch(job.bufferId, job.frameIndex);
  }
}

ImageRegistry::EnsureResult ImageRegistry::EnsureFrame(const std::string& bufferId,
                                                       int frameIndex) {
  return EnsureFrameImpl(bufferId, frameIndex, /*prefetchNeighbours=*/true);
}

void ImageRegistry::PinLocked(Entry& entry, int frameIndex, FramePin* pin) {
  if (!pin) return;
  Frame& f = entry.frames[static_cast<size_t>(frameIndex)];
  const uint8_t* data = f.kind == ImageStorageKind::Mmap ? f.mmap.rgbPtr() : f.ram.data();
  if (!data) return;
  f.pins += 1;
  pin->bufferId_ = entry.bufferId;
  pin->frameIndex_ = frameIndex;
  pin->data_ = data;
  pin->width_ = f.width;
  pin->height_ = f.height;
}

ImageRegistry::EnsureResult ImageRegistry::EnsureFrameNoPrefetch(
    const std::string& bufferId, int frameIndex) {
  return EnsureFrameImpl(bufferId, frameIndex, /*prefetchNeighbours=*/false);
}

ImageRegistry::EnsureResult ImageRegistry::EnsureFrameImpl(const std::string& bufferId,
                                                           int frameIndex,
                                                           bool prefetchNeighbours,
                                                           FramePin* pinOut) {
  EnsureResult r;
  if (bufferId.rfind("img_live_", 0) == 0) {
    std::shared_ptr<LiveImageEntry> live;
    {
      std::lock_guard<std::mutex> lock(mu_);
      auto it = liveEntries_.find(bufferId);
      if (it == liveEntries_.end()) {
        r.errorCode = "ERR_IMAGE_INVALID_ARGUMENT";
        r.errorMessage = "unknown bufferId";
        return r;
      }
      live = it->second;
    }
    ImageFrameInfo info;
    auto st = live->EnsureFrame(frameIndex, &info);
    r.ok = st.ok;
    r.errorCode = st.errorCode;
    r.errorMessage = st.errorMessage;
    r.info = info;
    return r;
  }


  std::shared_ptr<pdf::PdfLazyBackend> session;
  std::shared_ptr<ImageFileLazyBackend> fileLazy;
  int pageNumber = 0;
  uint64_t generation = 0;
  int frameCount = 0;
  bool alreadyHot = false;
  ImageFrameInfo hotInfo;

  {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = entries_.find(bufferId);
    if (it == entries_.end()) {
      r.errorCode = "ERR_IMAGE_INVALID_ARGUMENT";
      r.errorMessage = "unknown bufferId";
      return r;
    }
    Entry& entry = it->second;
    if (frameIndex < 0 || frameIndex >= static_cast<int>(entry.frames.size())) {
      r.errorCode = "ERR_IMAGE_INVALID_ARGUMENT";
      r.errorMessage = "frameIndex out of range";
      return r;
    }

    if (entry.state != ImageBufferState::Lazy) {
      FillFrameInfoLocked(entry.frames[static_cast<size_t>(frameIndex)], frameIndex,
                          r.info);
      r.ok = true;
      return r;
    }

    if (entry.isHot(static_cast<size_t>(frameIndex))) {
      TouchLruLocked(entry, frameIndex);
      PinLocked(entry, frameIndex, pinOut);
      FillFrameInfoLocked(entry.frames[static_cast<size_t>(frameIndex)], frameIndex,
                          hotInfo);
      alreadyHot = true;
      generation = entry.generation;
      frameCount = static_cast<int>(entry.frames.size());
    } else {
      if (!entry.pdfLazy && !entry.fileLazy) {
        r.errorCode = "ERR_PDF_INTERNAL";
        r.errorMessage = "lazy session missing";
        return r;
      }
      session = entry.pdfLazy;
      fileLazy = entry.fileLazy;
      pageNumber = entry.frames[static_cast<size_t>(frameIndex)].pageNumber;
      generation = entry.generation;
      frameCount = static_cast<int>(entry.frames.size());
    }
  }

  if (alreadyHot) {
    r.ok = true;
    r.info = hotInfo;
    // Need room for current + neighbor so prefetch cannot evict the frame
    // GetFrameRgbPtr / caller is about to read.
    int hotLimit = 0;
    {
      std::lock_guard<std::mutex> lock(mu_);
      auto it = entries_.find(bufferId);
      if (it != entries_.end()) hotLimit = it->second.hotFramesLimit;
    }
    if (prefetchNeighbours && hotLimit >= 2) {
      ScheduleNeighborPrefetch(bufferId, frameIndex, generation, frameCount);
    }
    return r;
  }

  RgbFrame rgb;
  std::string errCode;
  std::string errMsg;
  bool decoded = false;
  if (session) {
    decoded = session->RasterizePage(pageNumber, &rgb, &errCode, &errMsg);
    if (!decoded) {
      r.errorCode = errCode.empty() ? "ERR_PDF_RENDER_FAILED" : errCode;
      r.errorMessage = errMsg.empty() ? "lazy rasterize failed" : errMsg;
      return r;
    }
  } else if (fileLazy) {
    decoded = fileLazy->DecodeFrame(frameIndex, &rgb, &errCode, &errMsg);
    if (!decoded) {
      r.errorCode = errCode.empty() ? "ERR_IMAGE_DECODE_FAILED" : errCode;
      r.errorMessage = errMsg.empty() ? "lazy file decode failed" : errMsg;
      return r;
    }
  } else {
    r.errorCode = "ERR_PDF_INTERNAL";
    r.errorMessage = "lazy session missing";
    return r;
  }

  {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = entries_.find(bufferId);
    if (it == entries_.end() || it->second.generation != generation) {
      r.errorCode = "ERR_IMAGE_INVALID_ARGUMENT";
      r.errorMessage = "buffer released during ensure";
      return r;
    }
    Entry& entry = it->second;
    if (frameIndex < 0 || frameIndex >= static_cast<int>(entry.frames.size())) {
      r.errorCode = "ERR_IMAGE_INVALID_ARGUMENT";
      r.errorMessage = "frameIndex out of range";
      return r;
    }

    if (entry.isHot(static_cast<size_t>(frameIndex))) {
      Frame& hot = entry.frames[static_cast<size_t>(frameIndex)];
      if (fileLazy && hot.decoderProvider.empty()) {
        hot.decoderProvider = fileLazy->lastProvider();
        hot.decoderTier = fileLazy->lastTier();
        hot.decoderOrigin = fileLazy->lastOrigin();
      }
      TouchLruLocked(entry, frameIndex);
      PinLocked(entry, frameIndex, pinOut);
      FillFrameInfoLocked(hot, frameIndex, r.info);
      r.ok = true;
    } else {
      Frame& f = entry.frames[static_cast<size_t>(frameIndex)];
      f.width = rgb.width;
      f.height = rgb.height;
      // Keep the real size for later cold phases (eviction resets width).
      f.expectedWidth = rgb.width;
      f.expectedHeight = rgb.height;
      f.kind = ImageStorageKind::Ram;
      f.ram = std::move(rgb.rgb);
      // Decoded files carry no page number / dpi: keep the slot's metadata.
      if (rgb.pageNumber > 0) f.pageNumber = rgb.pageNumber;
      if (rgb.dpi > 0) f.dpi = rgb.dpi;
      if (fileLazy) {
        f.decoderProvider = fileLazy->lastProvider();
        f.decoderTier = fileLazy->lastTier();
        f.decoderOrigin = fileLazy->lastOrigin();
      }
      TouchLruLocked(entry, frameIndex);
      PinLocked(entry, frameIndex, pinOut);  // before eviction can pick it
      UpgradeEntryLocked(entry);
      EvictUntilUnderLimitLocked(entry);
      FillFrameInfoLocked(entry.frames[static_cast<size_t>(frameIndex)], frameIndex,
                          r.info);
      r.ok = true;
      IMG_LOGI(
          "[SherpaOnnx:image] ensure bufferId=%s frame=%d page=%d %dx%d hot=%d/%d",
          bufferId.c_str(), frameIndex, r.info.pageNumber, r.info.width,
          r.info.height, entry.hotCount(), entry.hotFramesLimit);
    }
  }

  int hotLimit = 0;
  {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = entries_.find(bufferId);
    if (it != entries_.end()) hotLimit = it->second.hotFramesLimit;
  }
  if (prefetchNeighbours && hotLimit >= 2) {
    ScheduleNeighborPrefetch(bufferId, frameIndex, generation, frameCount);
  }
  return r;
}

bool ImageRegistry::EvictFrame(const std::string& bufferId, int frameIndex) {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = entries_.find(bufferId);
  if (it == entries_.end()) return false;
  if (frameIndex < 0 || frameIndex >= static_cast<int>(it->second.frames.size())) {
    return false;
  }
  if (!it->second.isHot(static_cast<size_t>(frameIndex))) return true;
  if (it->second.frames[static_cast<size_t>(frameIndex)].pins > 0) return false;
  PDF_LAZY_LOGI("evictFrame bufferId=%s frame=%d", bufferId.c_str(), frameIndex);
  ClearFrameRgbLocked(it->second.frames[static_cast<size_t>(frameIndex)]);
  return true;
}

ImageRegistry::CreateResult ImageRegistry::CreateFromFiles(
    const std::vector<std::string>& paths, const DecodeOptions& opts,
    ProgressFn progress, CancelFn cancel) {
  CreateResult r;
  if (paths.empty()) {
    r.errorCode = "ERR_IMAGE_INVALID_ARGUMENT";
    r.errorMessage = "no paths";
    return r;
  }

  auto backend = std::make_shared<ImageFileLazyBackend>(opts);
  const int total = static_cast<int>(paths.size());
  for (int i = 0; i < total; ++i) {
    if (cancel && cancel()) {
      r.errorCode = "ERR_IMAGE_CANCELLED";
      r.errorMessage = "cancelled";
      return r;
    }
    if (progress) progress(i, total, "index");
    const std::string& path = paths[static_cast<size_t>(i)];
    if (path.empty()) {
      r.errorCode = "ERR_IMAGE_INVALID_ARGUMENT";
      r.errorMessage = "empty path";
      return r;
    }
    std::error_code ec;
    if (!fs::exists(path, ec) || !fs::is_regular_file(path, ec)) {
      r.errorCode = "ERR_IMAGE_DECODE_FAILED";
      r.errorMessage = "cannot open file: " + path;
      return r;
    }
    backend->AddPath(path);
  }
  if (progress) progress(total, total, "done");

  const int limit = ClampHotFrames(opts.hotFrames);
  std::lock_guard<std::mutex> lock(mu_);
  Entry e;
  e.bufferId = NewBufferId();
  e.pathType = ImageThresholdPathType::FileOrigin;
  e.state = ImageBufferState::Lazy;
  e.hotFramesLimit = limit;
  e.frames.resize(static_cast<size_t>(total));
  for (int i = 0; i < total; ++i) {
    Frame& f = e.frames[static_cast<size_t>(i)];
    backend->ExpectedSize(i, &f.expectedWidth, &f.expectedHeight);
  }
  e.fileLazy = std::move(backend);
  IMG_LOGI("[SherpaOnnx:image] createFromFiles lazy bufferId=%s frames=%d hotFrames=%d",
           e.bufferId.c_str(), total, limit);
  r.info.bufferId = e.bufferId;
  r.info.frameCount = total;
  r.info.totalBytes = 0;
  r.info.storageKind = ImageStorageKind::Ram;
  r.info.state = ImageBufferState::Lazy;
  r.bufferId = e.bufferId;
  r.ok = true;
  entries_[e.bufferId] = std::move(e);
  return r;
}

ImageRegistry::CreateResult ImageRegistry::CreateFromBytesList(
    const std::vector<std::vector<uint8_t>>& blobs, const DecodeOptions& opts,
    ImageThresholdPathType pathType, ProgressFn progress, CancelFn cancel) {
  CreateResult r;
  if (blobs.empty()) {
    r.errorCode = "ERR_IMAGE_INVALID_ARGUMENT";
    r.errorMessage = "no blobs";
    return r;
  }

  auto backend = std::make_shared<ImageFileLazyBackend>(opts);
  const int total = static_cast<int>(blobs.size());
  for (int i = 0; i < total; ++i) {
    if (cancel && cancel()) {
      r.errorCode = "ERR_IMAGE_CANCELLED";
      r.errorMessage = "cancelled";
      return r;
    }
    if (progress) progress(i, total, "index");
    const auto& blob = blobs[static_cast<size_t>(i)];
    if (blob.empty()) {
      r.errorCode = "ERR_IMAGE_DECODE_FAILED";
      r.errorMessage = "empty image bytes";
      return r;
    }
    backend->AddBytes(blob);
  }
  if (progress) progress(total, total, "done");

  const int limit = ClampHotFrames(opts.hotFrames);
  std::lock_guard<std::mutex> lock(mu_);
  Entry e;
  e.bufferId = NewBufferId();
  e.pathType = pathType;
  e.state = ImageBufferState::Lazy;
  e.hotFramesLimit = limit;
  e.frames.resize(static_cast<size_t>(total));
  for (int i = 0; i < total; ++i) {
    Frame& f = e.frames[static_cast<size_t>(i)];
    backend->ExpectedSize(i, &f.expectedWidth, &f.expectedHeight);
  }
  e.fileLazy = std::move(backend);
  IMG_LOGI("[SherpaOnnx:image] createFromBytes lazy bufferId=%s frames=%d hotFrames=%d",
           e.bufferId.c_str(), total, limit);
  r.info.bufferId = e.bufferId;
  r.info.frameCount = total;
  r.info.totalBytes = 0;
  r.info.storageKind = ImageStorageKind::Ram;
  r.info.state = ImageBufferState::Lazy;
  r.bufferId = e.bufferId;
  r.ok = true;
  entries_[e.bufferId] = std::move(e);
  return r;
}

ImageRegistry::CreateResult ImageRegistry::CreateLazyFromBackend(
    std::shared_ptr<ImageFileLazyBackend> backend, const std::vector<LazyFrameMeta>& meta,
    ImageThresholdPathType pathType, int hotFrames) {
  CreateResult r;
  if (!backend || backend->frame_count() <= 0) {
    r.errorCode = "ERR_IMAGE_INVALID_ARGUMENT";
    r.errorMessage = "no frames";
    return r;
  }
  const int total = backend->frame_count();
  const int limit = ClampHotFrames(hotFrames);
  std::lock_guard<std::mutex> lock(mu_);
  Entry e;
  e.bufferId = NewBufferId();
  e.pathType = pathType;
  e.state = ImageBufferState::Lazy;
  e.hotFramesLimit = limit;
  e.frames.resize(static_cast<size_t>(total));
  for (int i = 0; i < total; ++i) {
    Frame& f = e.frames[static_cast<size_t>(i)];
    backend->ExpectedSize(i, &f.expectedWidth, &f.expectedHeight);
    if (i < static_cast<int>(meta.size())) {
      f.sectionIndex = meta[static_cast<size_t>(i)].sectionIndex;
      f.href = meta[static_cast<size_t>(i)].href;
      f.pageNumber = meta[static_cast<size_t>(i)].pageNumber;
    }
  }
  e.fileLazy = std::move(backend);
  IMG_LOGI("[SherpaOnnx:image] createLazyFromBackend bufferId=%s frames=%d hotFrames=%d",
           e.bufferId.c_str(), total, limit);
  r.info.bufferId = e.bufferId;
  r.info.frameCount = total;
  r.info.totalBytes = 0;
  r.info.storageKind = ImageStorageKind::Ram;
  r.info.state = ImageBufferState::Lazy;
  r.bufferId = e.bufferId;
  r.ok = true;
  entries_[e.bufferId] = std::move(e);
  return r;
}

bool ImageRegistry::GetInfo(const std::string& bufferId, ImageBufferInfo& out) const {
  std::lock_guard<std::mutex> lock(mu_);
  auto liveIt = liveEntries_.find(bufferId);
  if (liveIt != liveEntries_.end()) {
    out = liveIt->second->Info();
    return true;
  }
  auto it = entries_.find(bufferId);
  if (it == entries_.end()) return false;
  out.bufferId = it->second.bufferId;
  out.kind = ImageBufferKind::Offline;
  out.frameCount = static_cast<int>(it->second.frames.size());
  out.totalBytes = it->second.totalBytes();
  out.storageKind = it->second.storageKind();
  out.state = it->second.state;
  return true;
}

bool ImageRegistry::GetFrameInfo(const std::string& bufferId, int frameIndex,
                                 ImageFrameInfo& out) const {
  std::lock_guard<std::mutex> lock(mu_);
  auto liveIt = liveEntries_.find(bufferId);
  if (liveIt != liveEntries_.end()) {
    return liveIt->second->GetFrameInfo(frameIndex, &out);
  }
  auto it = entries_.find(bufferId);
  if (it == entries_.end()) return false;
  if (frameIndex < 0 || frameIndex >= static_cast<int>(it->second.frames.size())) {
    return false;
  }
  FillFrameInfoLocked(it->second.frames[static_cast<size_t>(frameIndex)], frameIndex, out);
  return true;
}

const uint8_t* ImageRegistry::GetFrameRgbPtr(const std::string& bufferId, int frameIndex,
                                             int* outWidth, int* outHeight) {
  if (bufferId.rfind("img_live_", 0) == 0) {
    std::shared_ptr<LiveImageEntry> live;
    {
      std::lock_guard<std::mutex> lock(mu_);
      auto it = liveEntries_.find(bufferId);
      if (it == liveEntries_.end()) return nullptr;
      live = it->second;
    }
    return live->GetFrameRgbPtr(frameIndex, outWidth, outHeight);
  }
  {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = entries_.find(bufferId);
    if (it == entries_.end()) return nullptr;
    if (frameIndex < 0 || frameIndex >= static_cast<int>(it->second.frames.size())) {
      return nullptr;
    }
    if (it->second.state == ImageBufferState::Lazy &&
        !it->second.isHot(static_cast<size_t>(frameIndex))) {
      // Fall through to EnsureFrame below (must not hold lock).
    } else {
      const auto& f = it->second.frames[static_cast<size_t>(frameIndex)];
      if (outWidth) *outWidth = f.width;
      if (outHeight) *outHeight = f.height;
      if (f.kind == ImageStorageKind::Mmap) {
        return f.mmap.rgbPtr();
      }
      if (f.ram.size() ==
          static_cast<size_t>(f.width) * static_cast<size_t>(f.height) * 3u) {
        return f.ram.data();
      }
      return nullptr;
    }
  }

  auto ensured = EnsureFrame(bufferId, frameIndex);
  if (!ensured.ok) return nullptr;

  std::lock_guard<std::mutex> lock(mu_);
  auto it = entries_.find(bufferId);
  if (it == entries_.end()) return nullptr;
  if (frameIndex < 0 || frameIndex >= static_cast<int>(it->second.frames.size())) {
    return nullptr;
  }
  const auto& f = it->second.frames[static_cast<size_t>(frameIndex)];
  if (outWidth) *outWidth = f.width;
  if (outHeight) *outHeight = f.height;
  if (f.kind == ImageStorageKind::Mmap) {
    return f.mmap.rgbPtr();
  }
  if (f.ram.size() ==
      static_cast<size_t>(f.width) * static_cast<size_t>(f.height) * 3u) {
    return f.ram.data();
  }
  return nullptr;
}

// ---- FramePin ----

ImageRegistry::FramePin::FramePin(FramePin&& other) noexcept
    : bufferId_(std::move(other.bufferId_)),
      frameIndex_(other.frameIndex_),
      data_(other.data_),
      width_(other.width_),
      height_(other.height_) {
  other.frameIndex_ = -1;
  other.data_ = nullptr;
}

ImageRegistry::FramePin& ImageRegistry::FramePin::operator=(FramePin&& other) noexcept {
  if (this != &other) {
    reset();
    bufferId_ = std::move(other.bufferId_);
    frameIndex_ = other.frameIndex_;
    data_ = other.data_;
    width_ = other.width_;
    height_ = other.height_;
    other.frameIndex_ = -1;
    other.data_ = nullptr;
  }
  return *this;
}

ImageRegistry::FramePin::~FramePin() { reset(); }

void ImageRegistry::FramePin::reset() {
  if (frameIndex_ >= 0) {
    ImageRegistry::Instance().Unpin(bufferId_, frameIndex_);
  }
  frameIndex_ = -1;
  data_ = nullptr;
  width_ = 0;
  height_ = 0;
}

ImageRegistry::FramePin ImageRegistry::PinFrame(const std::string& bufferId,
                                                int frameIndex) {
  FramePin pin;
  if (bufferId.rfind("img_live_", 0) == 0) {
    pin.data_ = GetFrameRgbPtr(bufferId, frameIndex, &pin.width_, &pin.height_);
    return pin;
  }
  // A prefetch thread may evict between EnsureFrame and the pin; retry.
  for (int attempt = 0; attempt < 4; ++attempt) {
    {
      std::lock_guard<std::mutex> lock(mu_);
      auto it = entries_.find(bufferId);
      if (it == entries_.end()) return pin;
      Entry& entry = it->second;
      if (frameIndex < 0 || frameIndex >= static_cast<int>(entry.frames.size())) {
        return pin;
      }
      if (entry.isHot(static_cast<size_t>(frameIndex))) {
        Frame& f = entry.frames[static_cast<size_t>(frameIndex)];
        const uint8_t* data =
            f.kind == ImageStorageKind::Mmap ? f.mmap.rgbPtr() : f.ram.data();
        if (!data) return pin;
        f.pins += 1;
        if (entry.state == ImageBufferState::Lazy) TouchLruLocked(entry, frameIndex);
        pin.bufferId_ = bufferId;
        pin.frameIndex_ = frameIndex;
        pin.data_ = data;
        pin.width_ = f.width;
        pin.height_ = f.height;
        return pin;
      }
      if (entry.state != ImageBufferState::Lazy) return pin;
    }
    // Ensures and pins under the same lock, so no other thread can evict the
    // frame in between.
    if (!EnsureFrameImpl(bufferId, frameIndex, /*prefetchNeighbours=*/true, &pin).ok) {
      return pin;
    }
    if (pin) return pin;
  }
  return pin;
}

void ImageRegistry::Unpin(const std::string& bufferId, int frameIndex) {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = entries_.find(bufferId);
  if (it != entries_.end()) {
    if (frameIndex < static_cast<int>(it->second.frames.size())) {
      Frame& f = it->second.frames[static_cast<size_t>(frameIndex)];
      if (f.pins > 0) f.pins -= 1;
      if (f.pins == 0) EvictUntilUnderLimitLocked(it->second);
    }
    return;
  }
  auto rel = released_.find(bufferId);
  if (rel == released_.end()) return;
  Entry& entry = rel->second;
  if (frameIndex < static_cast<int>(entry.frames.size())) {
    Frame& f = entry.frames[static_cast<size_t>(frameIndex)];
    if (f.pins > 0) f.pins -= 1;
  }
  for (const auto& f : entry.frames) {
    if (f.pins > 0) return;
  }
  for (auto& f : entry.frames) ClearFrameRgbLocked(f);
  released_.erase(rel);
  IMG_LOGI("[SherpaOnnx:image] release (deferred) bufferId=%s", bufferId.c_str());
}

int ImageRegistry::FramePinCount(const std::string& bufferId, int frameIndex) const {
  std::lock_guard<std::mutex> lock(mu_);
  for (const auto* map : {&entries_, &released_}) {
    auto it = map->find(bufferId);
    if (it == map->end()) continue;
    if (frameIndex < 0 || frameIndex >= static_cast<int>(it->second.frames.size())) {
      return 0;
    }
    return it->second.frames[static_cast<size_t>(frameIndex)].pins;
  }
  return 0;
}

bool ImageRegistry::Release(const std::string& bufferId) {
  std::lock_guard<std::mutex> lock(mu_);
  auto liveIt = liveEntries_.find(bufferId);
  if (liveIt != liveEntries_.end()) {
    liveEntries_.erase(liveIt);
    IMG_LOGI("[SherpaOnnx:image] release live bufferId=%s", bufferId.c_str());
    return true;
  }
  auto it = entries_.find(bufferId);
  if (it == entries_.end()) return false;
  it->second.generation += 1;  // invalidate in-flight prefetch / ensure
  bool pinned = false;
  for (auto& f : it->second.frames) {
    if (f.pins > 0) {
      pinned = true;
      continue;
    }
    ClearFrameRgbLocked(f);
  }
  it->second.pdfLazy.reset();
  it->second.fileLazy.reset();
  if (pinned) {
    // A reader still holds frame memory: keep it until the last unpin.
    released_[bufferId] = std::move(it->second);
  }
  entries_.erase(it);
  IMG_LOGI("[SherpaOnnx:image] release bufferId=%s", bufferId.c_str());
  return true;
}

ImageRegistry::CreateResult ImageRegistry::CreateLive(const LiveImageOptions& opts) {
  std::lock_guard<std::mutex> lock(mu_);
  CreateResult r;
  const std::string id = NewLiveBufferId();
  auto live = LiveImageEntry::Create(opts, id);
  liveEntries_[id] = live;
  r.ok = true;
  r.bufferId = id;
  r.info = live->Info();
  IMG_LOGI("[SherpaOnnx:image] createLive bufferId=%s ringFrames=%d retention=%s",
           id.c_str(), opts.ringFrames,
           opts.retention == ImageRetention::Session ? "session" : "none");
  return r;
}

LiveImageEntry::Status ImageRegistry::AppendLiveCompressed(
    const std::string& bufferId, std::vector<uint8_t> bytes) {
  std::shared_ptr<LiveImageEntry> live;
  {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = liveEntries_.find(bufferId);
    if (it == liveEntries_.end()) {
      LiveImageEntry::Status s;
      s.errorCode = "ERR_IMAGE_BUFFER_NOT_FOUND";
      s.errorMessage = "unknown live bufferId";
      return s;
    }
    live = it->second;
  }
  auto st = live->AppendCompressed(std::move(bytes));
  if (st.ok) {
    const auto info = live->Info();
    IMG_LOGI(
        "[SherpaOnnx:image] live append bufferId=%s frames=%d written=%lld "
        "evicted=%lld spool=%d",
        bufferId.c_str(), info.frameCount,
        static_cast<long long>(info.totalFramesWritten),
        static_cast<long long>(info.ringEvictedFrames),
        info.hasActiveSpool ? 1 : 0);
  }
  return st;
}

LiveImageEntry::Status ImageRegistry::FinishLive(const std::string& bufferId) {
  std::shared_ptr<LiveImageEntry> live;
  {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = liveEntries_.find(bufferId);
    if (it == liveEntries_.end()) {
      LiveImageEntry::Status s;
      s.errorCode = "ERR_IMAGE_BUFFER_NOT_FOUND";
      s.errorMessage = "unknown live bufferId";
      return s;
    }
    live = it->second;
  }
  auto st = live->Finish();
  if (st.ok) {
    IMG_LOGI("[SherpaOnnx:image] live finish bufferId=%s", bufferId.c_str());
  }
  return st;
}

int ImageRegistry::FileLazyDecodeCount(const std::string& bufferId) const {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = entries_.find(bufferId);
  if (it == entries_.end() || !it->second.fileLazy) return -1;
  return it->second.fileLazy->decode_count();
}

int ImageRegistry::LiveDecodeCount(const std::string& bufferId) const {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = liveEntries_.find(bufferId);
  if (it == liveEntries_.end()) return -1;
  return it->second->DecodeCount();
}

void ImageRegistry::MaybeUpgradeToMmap(const std::string& bufferId,
                                       ImageThresholdPathType pathType) {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = entries_.find(bufferId);
  if (it == entries_.end()) return;
  it->second.pathType = pathType;
  UpgradeEntryLocked(it->second);
}

int ImageRegistry::SweepOrphanedTempFiles(int64_t maxAgeMs) {
  std::string dir;
  {
    std::lock_guard<std::mutex> lock(mu_);
    dir = cacheDir_;
  }
  if (dir.empty()) return 0;

  int deleted = 0;
  const auto now = std::chrono::system_clock::now();
  std::error_code ec;
  if (!fs::exists(dir, ec)) return 0;

  for (const auto& entry : fs::directory_iterator(dir, ec)) {
    if (ec) break;
    if (!entry.is_regular_file(ec)) continue;
    const auto name = entry.path().filename().string();
    // Prefix img_off_, suffix .rgb8
    if (name.rfind("img_off_", 0) != 0) continue;
    if (name.size() < 5 || name.substr(name.size() - 5) != ".rgb8") continue;

    struct stat st {};
    if (::stat(entry.path().c_str(), &st) != 0) continue;
    const auto mtime = std::chrono::system_clock::from_time_t(st.st_mtime);
    const auto ageMs =
        std::chrono::duration_cast<std::chrono::milliseconds>(now - mtime).count();
    if (ageMs < maxAgeMs) continue;

    std::error_code rmEc;
    fs::remove(entry.path(), rmEc);
    if (!rmEc) {
      ++deleted;
      IMG_LOGI("[SherpaOnnx:image] orphan sweep deleted %s", name.c_str());
    }
  }
  return deleted;
}

}  // namespace image
}  // namespace sherpa_onnx
