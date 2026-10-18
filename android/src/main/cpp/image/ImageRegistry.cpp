#include "ImageRegistry.h"

#include "PdfLazySession.h"

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
}

std::string ImageRegistry::NewBufferId() {
  return "img_off_" + FormatUuidV4();
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
  out.byteSize = static_cast<int64_t>(f.width) * static_cast<int64_t>(f.height) * 3;
  out.storageKind = f.kind;
  out.pageNumber = f.pageNumber;
  out.dpi = f.dpi;
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
    if (f.kind == ImageStorageKind::Ram && !f.ram.empty()) {
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
    e.frames.push_back(std::move(f));
  }
  return FinishCreateLocked(std::move(e));
}

ImageRegistry::CreateResult ImageRegistry::CreateLazyPdfSlots(
    std::unique_ptr<pdf::PdfLazySession> session,
    const std::vector<int>& pages_1based,
    int hotFrames) {
  CreateResult r;
  if (!session) {
    r.errorCode = "ERR_PDF_INTERNAL";
    r.errorMessage = "PdfLazySession required";
    return r;
  }

  const int page_count = session->page_count();
  const int dpi = session->dpi();
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
  e.pdfLazy = std::move(session);
  e.frames.reserve(pages.size());
  for (int page : pages) {
    Frame f;
    f.pageNumber = page;
    f.dpi = dpi;
    e.frames.push_back(std::move(f));
  }

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
      if (!entry.isHot(i)) continue;
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
  auto enqueue = [this](std::string id, int idx, uint64_t gen) {
    std::thread([this, id = std::move(id), idx, gen]() {
      {
        std::lock_guard<std::mutex> lock(mu_);
        auto it = entries_.find(id);
        if (it == entries_.end()) return;
        if (it->second.generation != gen) return;
        if (it->second.state != ImageBufferState::Lazy) return;
        if (idx < 0 || idx >= static_cast<int>(it->second.frames.size())) return;
        if (it->second.isHot(static_cast<size_t>(idx))) return;
      }
      PDF_LAZY_LOGI("prefetch bufferId=%s frame=%d", id.c_str(), idx);
      (void)EnsureFrame(id, idx);
    }).detach();
  };

  if (frameIndex - 1 >= 0) {
    enqueue(bufferId, frameIndex - 1, generation);
  }
  if (frameIndex + 1 < frameCount) {
    enqueue(bufferId, frameIndex + 1, generation);
  }
}

ImageRegistry::EnsureResult ImageRegistry::EnsureFrame(const std::string& bufferId,
                                                       int frameIndex) {
  EnsureResult r;

  pdf::PdfLazySession* session = nullptr;
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
      FillFrameInfoLocked(entry.frames[static_cast<size_t>(frameIndex)], frameIndex,
                          hotInfo);
      alreadyHot = true;
      generation = entry.generation;
      frameCount = static_cast<int>(entry.frames.size());
    } else {
      if (!entry.pdfLazy) {
        r.errorCode = "ERR_PDF_INTERNAL";
        r.errorMessage = "lazy session missing";
        return r;
      }
      session = entry.pdfLazy.get();
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
    if (hotLimit >= 2) {
      ScheduleNeighborPrefetch(bufferId, frameIndex, generation, frameCount);
    }
    return r;
  }

  RgbFrame rgb;
  std::string errCode;
  std::string errMsg;
  if (!session->RasterizePage(pageNumber, &rgb, &errCode, &errMsg)) {
    r.errorCode = errCode.empty() ? "ERR_PDF_RENDER_FAILED" : errCode;
    r.errorMessage = errMsg.empty() ? "lazy rasterize failed" : errMsg;
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
      TouchLruLocked(entry, frameIndex);
      FillFrameInfoLocked(entry.frames[static_cast<size_t>(frameIndex)], frameIndex,
                          r.info);
      r.ok = true;
    } else {
      Frame& f = entry.frames[static_cast<size_t>(frameIndex)];
      f.width = rgb.width;
      f.height = rgb.height;
      f.kind = ImageStorageKind::Ram;
      f.ram = std::move(rgb.rgb);
      f.pageNumber = rgb.pageNumber;
      f.dpi = rgb.dpi;
      TouchLruLocked(entry, frameIndex);
      UpgradeEntryLocked(entry);
      EvictUntilUnderLimitLocked(entry);
      FillFrameInfoLocked(entry.frames[static_cast<size_t>(frameIndex)], frameIndex,
                          r.info);
      r.ok = true;
      PDF_LAZY_LOGI(
          "ensure bufferId=%s frame=%d page=%d %dx%d hot=%d/%d",
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
  if (hotLimit >= 2) {
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

  Entry e;
  e.bufferId = NewBufferId();
  e.pathType = ImageThresholdPathType::FileOrigin;
  const int total = static_cast<int>(paths.size());

  for (int i = 0; i < total; ++i) {
    if (cancel && cancel()) {
      r.errorCode = "ERR_IMAGE_CANCELLED";
      r.errorMessage = "cancelled";
      return r;
    }
    if (progress) progress(i, total, "decode");

    auto decoded = ImageDecoder::DecodeFile(paths[static_cast<size_t>(i)], opts);
    if (!decoded.ok) {
      r.errorCode = decoded.errorCode.empty() ? "ERR_IMAGE_DECODE_FAILED" : decoded.errorCode;
      r.errorMessage = decoded.errorMessage + " (" + paths[static_cast<size_t>(i)] + ")";
      return r;
    }
    IMG_LOGI("[SherpaOnnx:image] decode file=%s format=%s %dx%d orient=%d scale=%.3f",
             paths[static_cast<size_t>(i)].c_str(), DecodeFormatName(decoded.format),
             decoded.frame.width, decoded.frame.height, decoded.orientationApplied,
             decoded.scaleApplied);

    Frame f;
    f.width = decoded.frame.width;
    f.height = decoded.frame.height;
    f.kind = ImageStorageKind::Ram;
    f.ram = std::move(decoded.frame.rgb);
    e.frames.push_back(std::move(f));
  }
  if (progress) progress(total, total, "done");

  std::lock_guard<std::mutex> lock(mu_);
  return FinishCreateLocked(std::move(e));
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

  Entry e;
  e.bufferId = NewBufferId();
  e.pathType = pathType;
  const int total = static_cast<int>(blobs.size());

  for (int i = 0; i < total; ++i) {
    if (cancel && cancel()) {
      r.errorCode = "ERR_IMAGE_CANCELLED";
      r.errorMessage = "cancelled";
      return r;
    }
    if (progress) progress(i, total, "decode");

    const auto& blob = blobs[static_cast<size_t>(i)];
    auto decoded = ImageDecoder::DecodeBytes(blob.data(), blob.size(), opts);
    if (!decoded.ok) {
      r.errorCode = decoded.errorCode.empty() ? "ERR_IMAGE_DECODE_FAILED" : decoded.errorCode;
      r.errorMessage = decoded.errorMessage;
      return r;
    }

    Frame f;
    f.width = decoded.frame.width;
    f.height = decoded.frame.height;
    f.kind = ImageStorageKind::Ram;
    f.ram = std::move(decoded.frame.rgb);
    e.frames.push_back(std::move(f));
  }
  if (progress) progress(total, total, "done");

  std::lock_guard<std::mutex> lock(mu_);
  return FinishCreateLocked(std::move(e));
}

bool ImageRegistry::GetInfo(const std::string& bufferId, ImageBufferInfo& out) const {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = entries_.find(bufferId);
  if (it == entries_.end()) return false;
  out.bufferId = it->second.bufferId;
  out.frameCount = static_cast<int>(it->second.frames.size());
  out.totalBytes = it->second.totalBytes();
  out.storageKind = it->second.storageKind();
  out.state = it->second.state;
  return true;
}

bool ImageRegistry::GetFrameInfo(const std::string& bufferId, int frameIndex,
                                 ImageFrameInfo& out) const {
  std::lock_guard<std::mutex> lock(mu_);
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

bool ImageRegistry::Release(const std::string& bufferId) {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = entries_.find(bufferId);
  if (it == entries_.end()) return false;
  it->second.generation += 1;  // invalidate in-flight prefetch / ensure
  for (auto& f : it->second.frames) {
    ClearFrameRgbLocked(f);
  }
  it->second.pdfLazy.reset();
  entries_.erase(it);
  IMG_LOGI("[SherpaOnnx:image] release bufferId=%s", bufferId.c_str());
  return true;
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
