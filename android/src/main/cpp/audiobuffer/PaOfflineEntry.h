#pragma once

/**
 * PaOfflineEntry + PaMmapRegion — shared AudioBuffer offline SoT.
 * Lifted from ios/audio/bridge/SherpaOnnx+PipelineAudio.mm
 */

#include <algorithm>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <fcntl.h>
#include <memory>
#include <string>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

#ifdef __OBJC__
#import <Foundation/Foundation.h>
#endif

struct PaMmapRegion {
  void *addr = MAP_FAILED;
  size_t length = 0;
  size_t dataOffsetBytes = 0;
  bool deleteOnRelease = true;
  std::string filePath;

  PaMmapRegion() = default;
  PaMmapRegion(const PaMmapRegion &) = delete;
  PaMmapRegion &operator=(const PaMmapRegion &) = delete;
  PaMmapRegion(PaMmapRegion &&o) noexcept
      : addr(o.addr), length(o.length), dataOffsetBytes(o.dataOffsetBytes),
        deleteOnRelease(o.deleteOnRelease), filePath(std::move(o.filePath)) {
    o.addr = MAP_FAILED;
    o.length = 0;
    o.dataOffsetBytes = 0;
  }
  PaMmapRegion &operator=(PaMmapRegion &&o) noexcept {
    if (this != &o) {
      release();
      addr = o.addr;
      length = o.length;
      dataOffsetBytes = o.dataOffsetBytes;
      deleteOnRelease = o.deleteOnRelease;
      filePath = std::move(o.filePath);
      o.addr = MAP_FAILED;
      o.length = 0;
      o.dataOffsetBytes = 0;
    }
    return *this;
  }
  ~PaMmapRegion() { release(); }

  bool isValid() const { return addr != MAP_FAILED && addr != nullptr && length > dataOffsetBytes; }
  const float *floatPtr() const {
    if (!isValid()) return nullptr;
    const uint8_t *base = reinterpret_cast<const uint8_t *>(addr);
    return reinterpret_cast<const float *>(base + dataOffsetBytes);
  }
  int numSamples() const {
    return isValid() ? (int)((length - dataOffsetBytes) / sizeof(float)) : 0;
  }

  void release() {
    if (isValid()) {
      munmap(addr, length);
      addr = MAP_FAILED;
      length = 0;
    }
    if (deleteOnRelease && !filePath.empty()) {
      unlink(filePath.c_str());
    }
    filePath.clear();
  }

  static std::unique_ptr<PaMmapRegion> mapFile(const std::string &path,
                                               size_t dataOffsetBytes = 0,
                                               bool deleteOnRelease = true) {
    int fd = open(path.c_str(), O_RDONLY);
    if (fd < 0) return nullptr;
    struct stat st;
    if (fstat(fd, &st) != 0 || st.st_size <= (off_t)dataOffsetBytes) {
      close(fd);
      return nullptr;
    }
    void *mapped = mmap(nullptr, st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
    close(fd);
    if (mapped == MAP_FAILED) return nullptr;
    auto region = std::make_unique<PaMmapRegion>();
    region->addr = mapped;
    region->length = (size_t)st.st_size;
    region->dataOffsetBytes = dataOffsetBytes;
    region->deleteOnRelease = deleteOnRelease;
    region->filePath = path;
    return region;
  }

  static std::unique_ptr<PaMmapRegion> createFromSamples(const float *samples,
                                                         size_t count,
                                                         const std::string &tempDir,
                                                         const std::string &bufferId) {
    std::string path = tempDir + "/pa_off_" + bufferId + ".f32";
    int fd = open(path.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) return nullptr;
    size_t bytes = count * sizeof(float);
    const uint8_t *src = reinterpret_cast<const uint8_t *>(samples);
    size_t remaining = bytes;
    while (remaining > 0) {
      ssize_t n = write(fd, src, remaining);
      if (n < 0) {
        if (errno == EINTR) continue;
        close(fd);
        unlink(path.c_str());
        return nullptr;
      }
      if (n == 0) {
        close(fd);
        unlink(path.c_str());
        return nullptr;
      }
      src += n;
      remaining -= (size_t)n;
    }
    close(fd);
    return mapFile(path);
  }
};

struct PaOfflineEntry {
  std::string bufferId;
  int sampleRate = 0;
  int channelCount = 0;
  std::vector<float> samples;
  std::unique_ptr<PaMmapRegion> mmapRegion;

  bool isMmapBacked() const { return mmapRegion && mmapRegion->isValid(); }
  std::string storageKind() const { return isMmapBacked() ? "mmap" : "ram"; }
  int numSamples() const {
    return isMmapBacked() ? mmapRegion->numSamples() : (int)samples.size();
  }
  double durationMs() const {
    return sampleRate > 0 ? (double)numSamples() / sampleRate * 1000.0 : 0.0;
  }
  const float *floatPtr() const {
    if (isMmapBacked()) return mmapRegion->floatPtr();
    return samples.empty() ? nullptr : samples.data();
  }

#ifdef __OBJC__
  NSDictionary *toDict() const {
    return @{
      @"bufferId" : [NSString stringWithUTF8String:bufferId.c_str()],
      @"kind" : @"offlinePcmBuffer",
      @"state" : @"immutable",
      @"sampleRate" : @(sampleRate),
      @"channelCount" : @(channelCount),
      @"numSamples" : @(numSamples()),
      @"durationMs" : @(durationMs()),
      @"storageKind" : [NSString stringWithUTF8String:storageKind().c_str()]
    };
  }
#endif

  std::vector<float> readAllSamples() const {
    if (!isMmapBacked()) return samples;
    const float *ptr = mmapRegion->floatPtr();
    int n = mmapRegion->numSamples();
    return std::vector<float>(ptr, ptr + n);
  }

  std::vector<float> readSlice(int startSample, int count) const {
    int total = numSamples();
    int safeStart = std::max(0, startSample);
    if (safeStart >= total) return {};
    int actualCount = std::min(count, total - safeStart);
    const float *base = floatPtr();
    if (!base) return {};
    return std::vector<float>(base + safeStart, base + safeStart + actualCount);
  }

  void release() {
    if (mmapRegion) {
      mmapRegion->release();
      mmapRegion.reset();
    }
    samples.clear();
    samples.shrink_to_fit();
  }
};
