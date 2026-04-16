/**
 * SherpaOnnx+PipelineAudio.mm
 *
 * Unified pipeline audio buffer registry for iOS.
 * Mirrors the Kotlin PipelineAudioRegistry with two buffer kinds:
 * - OfflineEntry: immutable PCM (in-memory or file-backed)
 * - LiveEntry: streaming PCM with ring buffer, optional WAV spool, consumer cursors
 *
 * Implements all TurboModule methods for createOfflineAudioBuffer*, createEmptyLiveAudioBuffer,
 * appendSamples*, finalize, save, info, release, and file ingest.
 * Mic capture methods are implemented in SherpaOnnx+PipelineAudioMic.mm.
 */

#import "../../SherpaOnnx.h"
#import <React/RCTLog.h>
#import "fileio/FileIOResolver.h"
#import "fileio/FileIOStreamCopy.h"
#include "sherpa-onnx/c-api/cxx-api.h"
#include "../pipeline/PaLiveEntry.h"
#include "AudioDecodeSession.h"
#include "AudioEncodeSession.h"
#include <mutex>
#include <unordered_map>
#include <vector>
#include <string>
#include <set>
#include <fstream>
#include <functional>
#include <cmath>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <thread>
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>

// ==================== Error Codes ====================
static NSString *const kPAErrBufferNotFound   = @"AUDIO_BUFFER_NOT_FOUND";
static NSString *const kPAErrInvalidArgument  = @"AUDIO_INVALID_ARGUMENT";
static NSString *const kPAErrInvalidState     = @"AUDIO_INVALID_STATE";
static NSString *const kPAErrFileNotFound     = @"AUDIO_FILE_NOT_FOUND";
static NSString *const kPAErrFileReadError    = @"AUDIO_FILE_READ_ERROR";
static NSString *const kPAErrFileWriteError   = @"AUDIO_FILE_WRITE_ERROR";
static NSString *const kPAErrAlreadyFinalized = @"AUDIO_ALREADY_FINALIZED";
static NSString *const kPAErrInternalError    = @"AUDIO_INTERNAL_ERROR";

// Source constants, pa_resampleLinear, pa_writeWavHeaderToStream, and PaLiveEntry are defined in PaLiveEntry.h (included above).

// ==================== WAV Utilities ====================

struct PaWavHeader {
  int sampleRate = 0;
  int channelCount = 0;
  int bitsPerSample = 0;
  int audioFormat = 0; // 1=PCM, 3=float
  long dataOffset = 0;
  long dataSize = 0;
  int numSamples = 0;
};

static bool pa_parseWavHeader(const std::string &filePath, PaWavHeader &hdr) {
  std::ifstream f(filePath, std::ios::binary);
  if (!f) return false;

  char buf[4];
  auto readU32LE = [&]() -> uint32_t {
    uint32_t v = 0;
    f.read(reinterpret_cast<char*>(&v), 4);
    return v;
  };
  auto readU16LE = [&]() -> uint16_t {
    uint16_t v = 0;
    f.read(reinterpret_cast<char*>(&v), 2);
    return v;
  };

  f.read(buf, 4); if (std::string(buf, 4) != "RIFF") return false;
  readU32LE(); // file size
  f.read(buf, 4); if (std::string(buf, 4) != "WAVE") return false;

  while (f) {
    f.read(buf, 4); if (!f) break;
    std::string chunkId(buf, 4);
    uint32_t chunkSize = readU32LE();
    long chunkStart = f.tellg();

    if (chunkId == "fmt ") {
      if (chunkSize < 16) { f.seekg(chunkStart + chunkSize); continue; }
      hdr.audioFormat = readU16LE();
      hdr.channelCount = readU16LE();
      hdr.sampleRate = readU32LE();
      readU32LE(); // byteRate
      readU16LE(); // blockAlign
      hdr.bitsPerSample = readU16LE();
      f.seekg(chunkStart + chunkSize);
    } else if (chunkId == "data") {
      hdr.dataOffset = f.tellg();
      hdr.dataSize = chunkSize;
      break;
    } else {
      f.seekg(chunkStart + chunkSize);
    }
  }

  if (hdr.dataSize <= 0 || hdr.sampleRate <= 0) return false;
  bool supported = (hdr.audioFormat == 1 && hdr.bitsPerSample == 16 && hdr.channelCount == 1) ||
                   (hdr.audioFormat == 3 && hdr.bitsPerSample == 32 && hdr.channelCount == 1);
  if (!supported) return false;
  hdr.numSamples = (int)(hdr.dataSize / (hdr.bitsPerSample / 8));
  return true;
}

// pa_writeWavHeaderToStream is provided by PaLiveEntry.h

// ==================== Mmap Region ====================

/**
 * RAII wrapper for a POSIX mmap region over a raw float32 file.
 */
struct PaMmapRegion {
  void *addr = MAP_FAILED;
  size_t length = 0;
  std::string filePath;

  PaMmapRegion() = default;
  PaMmapRegion(const PaMmapRegion &) = delete;
  PaMmapRegion &operator=(const PaMmapRegion &) = delete;
  PaMmapRegion(PaMmapRegion &&o) noexcept : addr(o.addr), length(o.length), filePath(std::move(o.filePath)) {
    o.addr = MAP_FAILED;
    o.length = 0;
  }
  PaMmapRegion &operator=(PaMmapRegion &&o) noexcept {
    if (this != &o) {
      release();
      addr = o.addr;
      length = o.length;
      filePath = std::move(o.filePath);
      o.addr = MAP_FAILED;
      o.length = 0;
    }
    return *this;
  }
  ~PaMmapRegion() { release(); }

  bool isValid() const { return addr != MAP_FAILED && addr != nullptr; }
  const float *floatPtr() const { return isValid() ? reinterpret_cast<const float *>(addr) : nullptr; }
  int numSamples() const { return isValid() ? (int)(length / sizeof(float)) : 0; }

  void release() {
    if (isValid()) {
      munmap(addr, length);
      addr = MAP_FAILED;
      length = 0;
    }
    if (!filePath.empty()) {
      unlink(filePath.c_str());
      filePath.clear();
    }
  }

  /** Map an existing raw .f32 file. */
  static std::unique_ptr<PaMmapRegion> mapFile(const std::string &path) {
    int fd = open(path.c_str(), O_RDONLY);
    if (fd < 0) return nullptr;

    struct stat st;
    if (fstat(fd, &st) != 0 || st.st_size == 0) { close(fd); return nullptr; }

    void *mapped = mmap(nullptr, st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
    close(fd);
    if (mapped == MAP_FAILED) return nullptr;

    auto region = std::make_unique<PaMmapRegion>();
    region->addr = mapped;
    region->length = (size_t)st.st_size;
    region->filePath = path;
    return region;
  }

  /** Write raw float32 data to a temp file and mmap it. */
  static std::unique_ptr<PaMmapRegion> createFromSamples(
    const float *samples,
    size_t count,
    const std::string &tempDir,
    const std::string &bufferId
  ) {
    std::string path = tempDir + "/pa_off_" + bufferId + ".f32";
    int fd = open(path.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) return nullptr;

    size_t bytes = count * sizeof(float);
    ssize_t written = write(fd, samples, bytes);
    close(fd);
    if (written != (ssize_t)bytes) { unlink(path.c_str()); return nullptr; }

    return mapFile(path);
  }
};

// ==================== Offline Entry ====================

struct PaOfflineEntry {
  std::string bufferId;
  int sampleRate;
  int channelCount;
  // In-memory variant
  std::vector<float> samples;
  // Mmap-backed variant
  std::unique_ptr<PaMmapRegion> mmapRegion;

  bool isMmapBacked() const { return mmapRegion && mmapRegion->isValid(); }
  std::string storageKind() const { return isMmapBacked() ? "mmap" : "ram"; }

  int numSamples() const {
    return isMmapBacked() ? mmapRegion->numSamples() : (int)samples.size();
  }
  double durationMs() const {
    return sampleRate > 0 ? (double)numSamples() / sampleRate * 1000.0 : 0.0;
  }

  /** Get direct float pointer for zero-copy reads. Works for both variants. */
  const float *floatPtr() const {
    if (isMmapBacked()) return mmapRegion->floatPtr();
    return samples.empty() ? nullptr : samples.data();
  }

  NSDictionary *toDict() const {
    return @{
      @"bufferId": [NSString stringWithUTF8String:bufferId.c_str()],
      @"kind": @"offlinePcmBuffer",
      @"state": @"immutable",
      @"sampleRate": @(sampleRate),
      @"channelCount": @(channelCount),
      @"numSamples": @(numSamples()),
      @"durationMs": @(durationMs()),
      @"storageKind": [NSString stringWithUTF8String:storageKind().c_str()]
    };
  }

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

// PaLiveEntry is defined in PaLiveEntry.h (included above).

// ==================== Registry ====================

// Non-static: shared with SherpaOnnx+STT.mm via SherpaOnnx+PipelineAudioGlobals.h
std::unordered_map<std::string, std::shared_ptr<PaOfflineEntry>> g_pa_offline;
std::unordered_map<std::string, std::shared_ptr<PaLiveEntry>> g_pa_live;
std::mutex g_pa_mutex;
static const long kPaFileBackedThreshold = 10L * 1024 * 1024; // 10 MB raw PCM

static std::string pa_tempDir() {
  return [NSTemporaryDirectory() UTF8String];
}

/**
 * Create an entry, using mmap if the raw PCM size exceeds the threshold.
 * The samples vector is consumed (moved) on success for the in-memory path.
 */
static std::shared_ptr<PaOfflineEntry> pa_createEntryWithThreshold(
  const std::string &bufferId,
  int sampleRate,
  int channelCount,
  std::vector<float> &samples
) {
  auto entry = std::make_shared<PaOfflineEntry>();
  entry->bufferId = bufferId;
  entry->sampleRate = sampleRate;
  entry->channelCount = channelCount;

  long rawSize = (long)samples.size() * sizeof(float);
  if (rawSize >= kPaFileBackedThreshold) {
    auto region = PaMmapRegion::createFromSamples(samples.data(), samples.size(), pa_tempDir(), bufferId);
    if (region) {
      entry->mmapRegion = std::move(region);
      return entry; // samples vector not moved — caller can let it destruct
    }
  }
  entry->samples = std::move(samples);
  return entry;
}

/**
 * Upgrade an entry to mmap if it exceeds the threshold.
 * Used after adoptSamples in enhancement output.
 */
void pa_upgradeToMmapIfNeeded(const std::string &bufferId) {
  std::shared_ptr<PaOfflineEntry> entry;
  {
    std::lock_guard<std::mutex> lock(g_pa_mutex);
    auto it = g_pa_offline.find(bufferId);
    if (it == g_pa_offline.end()) return;
    entry = it->second;
  }
  if (entry->isMmapBacked()) return;
  long rawSize = (long)entry->samples.size() * sizeof(float);
  if (rawSize < kPaFileBackedThreshold) return;

  auto region = PaMmapRegion::createFromSamples(
    entry->samples.data(), entry->samples.size(), pa_tempDir(), bufferId
  );
  if (!region) return;

  entry->mmapRegion = std::move(region);
  entry->samples.clear();
  entry->samples.shrink_to_fit();
}

/**
 * Stream a WAV spool file directly to a raw .f32 file, then mmap it.
 * Avoids loading the entire file into memory (OOM fix for large spool files).
 * Returns a valid entry on success, or null if conversion fails.
 */
static std::shared_ptr<PaOfflineEntry> pa_createOfflineFromWavSpoolFileStreaming(
  const std::string &bufferId,
  const std::string &spoolPath,
  const PaWavHeader &hdr
) {
  std::string tempDir = pa_tempDir();
  std::string f32Path = tempDir + "/pa_off_" + bufferId + ".f32";

  try {
    // Open WAV for reading and F32 for writing
    std::ifstream wavFile(spoolPath, std::ios::binary);
    if (!wavFile) return nullptr;
    wavFile.seekg(hdr.dataOffset);

    std::ofstream f32File(f32Path, std::ios::binary);
    if (!f32File) return nullptr;

    // Stream convert samples in chunks (avoid allocating 100+ MB at once)
    const int chunkSize = 8192;
    std::vector<float> chunk(chunkSize);

    if (hdr.audioFormat == 1 && hdr.bitsPerSample == 16) {
      // S16 PCM → F32
      std::vector<int16_t> s16Buf(chunkSize);
      int samplesRemaining = hdr.numSamples;
      while (samplesRemaining > 0) {
        int toRead = std::min(chunkSize, samplesRemaining);
        wavFile.read(reinterpret_cast<char*>(s16Buf.data()), toRead * 2);
        int actualRead = wavFile.gcount() / 2;
        if (actualRead <= 0) break;

        for (int i = 0; i < actualRead; i++) {
          chunk[i] = (float)s16Buf[i] / 32768.0f;
        }
        // Write raw float32 bytes
        f32File.write(reinterpret_cast<const char*>(chunk.data()), actualRead * 4);
        samplesRemaining -= actualRead;
      }
    } else if (hdr.audioFormat == 3 && hdr.bitsPerSample == 32) {
      // F32 PCM → F32 (pass-through)
      int samplesRemaining = hdr.numSamples;
      while (samplesRemaining > 0) {
        int toRead = std::min(chunkSize, samplesRemaining);
        wavFile.read(reinterpret_cast<char*>(chunk.data()), toRead * 4);
        int actualRead = wavFile.gcount() / 4;
        if (actualRead <= 0) break;
        f32File.write(reinterpret_cast<const char*>(chunk.data()), actualRead * 4);
        samplesRemaining -= actualRead;
      }
    } else {
      // Unsupported format
      return nullptr;
    }

    f32File.close();
    wavFile.close();

    // Mmap the written .f32 file
    auto region = PaMmapRegion::mapFile(f32Path);
    if (!region) {
      unlink(f32Path.c_str());
      return nullptr;
    }

    // Create entry with mmapped region
    auto entry = std::make_shared<PaOfflineEntry>();
    entry->bufferId = bufferId;
    entry->sampleRate = hdr.sampleRate;
    entry->channelCount = hdr.channelCount;
    entry->mmapRegion = std::move(region);
    return entry;

  } catch (...) {
    unlink(f32Path.c_str());
    return nullptr;
  }
}


/**
 * Sweep orphaned pa_off_*.f32 temp files older than maxAgeSec.
 */
void pa_sweepOrphanedTempFiles(int maxAgeSec) {
  NSString *tmpDir = NSTemporaryDirectory();
  NSFileManager *fm = [NSFileManager defaultManager];
  NSArray<NSString *> *files = [fm contentsOfDirectoryAtPath:tmpDir error:nil];
  if (!files) return;

  NSDate *now = [NSDate date];
  for (NSString *name in files) {
    if (![name hasPrefix:@"pa_off_"] || ![name hasSuffix:@".f32"]) continue;
    NSString *fullPath = [tmpDir stringByAppendingPathComponent:name];
    NSDictionary *attrs = [fm attributesOfItemAtPath:fullPath error:nil];
    NSDate *mod = attrs[NSFileModificationDate];
    if (mod && [now timeIntervalSinceDate:mod] > maxAgeSec) {
      [fm removeItemAtPath:fullPath error:nil];
      RCTLogInfo(@"Orphan sweep: deleted %@", name);
    }
  }
}
static std::string pa_generateId(const char *prefix);

// Decode cancel registry: operationId → atomic cancel flag
static std::unordered_map<std::string, std::shared_ptr<std::atomic<bool>>> g_pa_decodeCancelFlags;
static std::mutex g_pa_decodeCancelMutex;

// Audio save cancel registry: operationId → atomic cancel flag
static std::unordered_map<std::string, std::shared_ptr<std::atomic<bool>>> g_pa_saveCancelFlags;
static std::mutex g_pa_saveCancelMutex;

// File ingest status registry
struct PaFileIngestStatus {
  bool isRunning = true;
  int64_t framesIngested = 0;
  int64_t totalFramesEstimate = 0;
  int percent = 0;
  std::string error;
};
static std::unordered_map<std::string, std::shared_ptr<PaFileIngestStatus>> g_pa_fileIngestStatuses;
static std::mutex g_pa_fileIngestMutex;

std::shared_ptr<PaLiveEntry> pa_get_live_entry(const std::string &bufferId) {
  std::lock_guard<std::mutex> lock(g_pa_mutex);
  auto it = g_pa_live.find(bufferId);
  if (it == g_pa_live.end()) {
    return nullptr;
  }
  return it->second;
}

bool pa_read_offline_samples(
  const std::string &bufferId,
  std::vector<float> *samples,
  int *sampleRate
) {
  std::shared_ptr<PaOfflineEntry> entry;
  {
    std::lock_guard<std::mutex> lock(g_pa_mutex);
    auto it = g_pa_offline.find(bufferId);
    if (it == g_pa_offline.end() || !it->second) {
      return false;
    }
    entry = it->second;
  }

  if (sampleRate != nullptr) {
    *sampleRate = entry->sampleRate;
  }
  if (samples != nullptr) {
    *samples = entry->readAllSamples();
  }
  return true;
}

static std::string pa_offline_info_json(const std::shared_ptr<PaOfflineEntry> &entry) {
  return std::string("{") +
    "\"bufferId\":\"" + entry->bufferId + "\"," +
    "\"kind\":\"offlinePcmBuffer\"," +
    "\"state\":\"immutable\"," +
    "\"sampleRate\":" + std::to_string(entry->sampleRate) + "," +
    "\"channelCount\":" + std::to_string(entry->channelCount) + "," +
    "\"numSamples\":" + std::to_string(entry->numSamples()) + "," +
    "\"durationMs\":" + std::to_string(entry->durationMs()) +
    "}";
}

bool pa_create_offline_from_samples(
  const float *samples,
  size_t count,
  int sampleRate,
  int channelCount,
  std::string *json,
  std::string *errorCode,
  std::string *errorMessage
) {
  if (samples == nullptr || count == 0) {
    if (errorCode) *errorCode = "[INVALID_ARGS]";
    if (errorMessage) *errorMessage = "samples must not be empty";
    return false;
  }
  if (sampleRate <= 0) {
    if (errorCode) *errorCode = "[INVALID_ARGS]";
    if (errorMessage) *errorMessage = "sampleRate must be > 0";
    return false;
  }
  if (channelCount != 1) {
    if (errorCode) *errorCode = "[INVALID_ARGS]";
    if (errorMessage) *errorMessage = "Only mono (channelCount=1) is supported";
    return false;
  }

  std::string bufferId = pa_generateId("off");
  std::vector<float> sampleVec(samples, samples + count);
  auto entry = pa_createEntryWithThreshold(bufferId, sampleRate, channelCount, sampleVec);

  {
    std::lock_guard<std::mutex> lock(g_pa_mutex);
    g_pa_offline[bufferId] = entry;
  }

  if (json) {
    *json = pa_offline_info_json(entry);
  }
  return true;
}

bool pa_get_offline_samples_slice(
  const std::string &bufferId,
  int startFrame,
  int frameCount,
  std::vector<float> *out,
  std::string *errorCode,
  std::string *errorMessage
) {
  if (out) out->clear();

  std::shared_ptr<PaOfflineEntry> entry;
  {
    std::lock_guard<std::mutex> lock(g_pa_mutex);
    auto it = g_pa_offline.find(bufferId);
    if (it == g_pa_offline.end() || !it->second) {
      if (errorCode) *errorCode = "[BUFFER_NOT_FOUND]";
      if (errorMessage) *errorMessage = "Offline buffer not found";
      return false;
    }
    entry = it->second;
  }

  if (entry->isMmapBacked()) {
    // mmap-backed: use readSlice for zero-copy
    if (frameCount <= 0 || out == nullptr) {
      return true;
    }
    *out = entry->readSlice(startFrame, frameCount);
    return true;
  }

  if (frameCount <= 0 || out == nullptr) {
    return true;
  }

  const int safeStart = std::max(0, startFrame);
  const int total = (int)entry->samples.size();
  if (safeStart >= total) {
    return true;
  }

  const int endExclusive = std::min(total, safeStart + frameCount);
  out->assign(entry->samples.begin() + safeStart, entry->samples.begin() + endExclusive);
  return true;
}

bool pa_get_live_samples_slice(
  const std::string &bufferId,
  int startFrame,
  int frameCount,
  std::vector<float> *out,
  std::string *errorCode,
  std::string *errorMessage
) {
  if (out) out->clear();

  std::shared_ptr<PaLiveEntry> entry;
  {
    std::lock_guard<std::mutex> lock(g_pa_mutex);
    auto it = g_pa_live.find(bufferId);
    if (it == g_pa_live.end() || !it->second) {
      if (errorCode) *errorCode = "[BUFFER_NOT_FOUND]";
      if (errorMessage) *errorMessage = "Live buffer not found";
      return false;
    }
    entry = it->second;
  }

  if (frameCount <= 0 || out == nullptr) {
    return true;
  }

  *out = entry->getSamplesSlice(std::max(0, startFrame), frameCount);
  return true;
}

bool pa_append_samples_to_live(
  const std::string &bufferId,
  const float *samples,
  size_t count,
  int sampleRate,
  std::string *errorCode,
  std::string *errorMessage
) {
  if (samples == nullptr || count == 0) {
    if (errorCode) *errorCode = "[INVALID_ARGS]";
    if (errorMessage) *errorMessage = "samples must not be empty";
    return false;
  }

  std::shared_ptr<PaLiveEntry> entry;
  {
    std::lock_guard<std::mutex> lock(g_pa_mutex);
    auto it = g_pa_live.find(bufferId);
    if (it == g_pa_live.end() || !it->second) {
      if (errorCode) *errorCode = "[BUFFER_NOT_FOUND]";
      if (errorMessage) *errorMessage = "Live buffer not found";
      return false;
    }
    entry = it->second;
  }

  if (entry->state != PaLiveEntry::RECORDING) {
    if (errorCode) *errorCode = "[BUFFER_NOT_RECORDING]";
    if (errorMessage) *errorMessage = "Live buffer is finalized";
    return false;
  }

  entry->appendSamples(samples, count, sampleRate, kPaAppendSourceAppend);
  return true;
}

bool pa_get_offline_metadata(
  const std::string &bufferId,
  int *sampleRate,
  int *numSamples,
  std::string *errorCode,
  std::string *errorMessage
) {
  std::lock_guard<std::mutex> lock(g_pa_mutex);
  auto it = g_pa_offline.find(bufferId);
  if (it == g_pa_offline.end() || !it->second) {
    if (errorCode) *errorCode = "[BUFFER_NOT_FOUND]";
    if (errorMessage) *errorMessage = "Offline buffer not found";
    return false;
  }
  if (sampleRate) *sampleRate = it->second->sampleRate;
  if (numSamples) *numSamples = it->second->numSamples();
  return true;
}

bool pa_adopt_offline_samples_if_empty(
  const std::string &bufferId,
  std::vector<float> &&samples,
  std::string *errorCode,
  std::string *errorMessage
) {
  std::lock_guard<std::mutex> lock(g_pa_mutex);
  auto it = g_pa_offline.find(bufferId);
  if (it == g_pa_offline.end() || !it->second) {
    if (errorCode) *errorCode = "[BUFFER_NOT_FOUND]";
    if (errorMessage) *errorMessage = "Offline buffer not found";
    return false;
  }

  auto entry = it->second;
  if (entry->numSamples() != 0) {
    if (errorCode) *errorCode = "[BUFFER_NOT_EMPTY]";
    if (errorMessage) *errorMessage = "Offline buffer already populated";
    return false;
  }

  entry->samples = std::move(samples);
  return true;
}

static std::string pa_generateId(const char *prefix) {
  return std::string(prefix) + "_" + [[[NSUUID UUID] UUIDString] UTF8String];
}

// ==================== Category Implementation ====================

@implementation SherpaOnnx (PipelineAudio)

// ---- Offline: from source (unified decode via AudioDecodeSession) ----
#if __has_include(<SherpaOnnxSpec/SherpaOnnxSpec.h>)
- (void)decodeFileToOfflineBuffer:(NSDictionary *)source
             targetSampleRateHz:(double)targetSampleRateHz
                      forceMono:(BOOL)forceMono
                    operationId:(NSString *)operationId
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject
{
  // Register cancel flag
  auto cancelFlag = std::make_shared<std::atomic<bool>>(false);
  std::string opId = [operationId UTF8String];
  {
    std::lock_guard<std::mutex> lock(g_pa_decodeCancelMutex);
    g_pa_decodeCancelFlags[opId] = cancelFlag;
  }

  __weak SherpaOnnx *weakSelf = self;

  dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
    @try {
      // Resolve FileSource to a local file path
      NSString *errCode = nil, *errMsg = nil;
      FileIOReadHandle *readHandle = [FileIOResolver resolveSource:source error:&errCode message:&errMsg];
      if (!readHandle) {
        {
          std::lock_guard<std::mutex> lock(g_pa_decodeCancelMutex);
          g_pa_decodeCancelFlags.erase(opId);
        }
        reject(errCode, errMsg, nil);
        return;
      }

      NSString *sourcePath = nil;
      NSString *tmpPath = nil;
      if (readHandle.isFilePath) {
        sourcePath = readHandle.filePath;
      } else {
        // Stream → copy to temp
        tmpPath = [NSTemporaryDirectory() stringByAppendingPathComponent:
                   [NSString stringWithFormat:@"fileio_buf_%@", [[NSUUID UUID] UUIDString]]];
        NSOutputStream *out = [NSOutputStream outputStreamToFileAtPath:tmpPath append:NO];
        [out open];
        [readHandle.stream open];
        uint8_t buf[65536];
        NSInteger bytesRead;
        while ((bytesRead = [readHandle.stream read:buf maxLength:sizeof(buf)]) > 0) {
          [out write:buf maxLength:bytesRead];
        }
        [out close];
        sourcePath = tmpPath;
      }

      std::string path = [sourcePath UTF8String];
      if (![[NSFileManager defaultManager] fileExistsAtPath:sourcePath]) {
        [readHandle cleanup];
        if (tmpPath) [[NSFileManager defaultManager] removeItemAtPath:tmpPath error:nil];
        {
          std::lock_guard<std::mutex> lock(g_pa_decodeCancelMutex);
          g_pa_decodeCancelFlags.erase(opId);
        }
        reject(kPAErrFileNotFound, @"Audio file does not exist", nil);
        return;
      }

      // Configure decode
      sherpa::AudioDecodeConfig config;
      config.targetSampleRate = (int)targetSampleRateHz;
      config.forceMono = forceMono;
      config.chunkSize = 8192;

      // Stream decoded chunks directly to a raw .f32 temp file on disk.
      // This avoids building a huge std::vector<float> in heap (OOM fix for large files).
      std::string bufferId = pa_generateId("off");
      std::string tmpDir = pa_tempDir();
      std::string f32Path = tmpDir + "/pa_off_" + bufferId + ".f32";
      FILE *outFile = fopen(f32Path.c_str(), "wb");
      if (!outFile) {
        [readHandle cleanup];
        if (tmpPath) [[NSFileManager defaultManager] removeItemAtPath:tmpPath error:nil];
        {
          std::lock_guard<std::mutex> lock(g_pa_decodeCancelMutex);
          g_pa_decodeCancelFlags.erase(opId);
        }
        reject(kPAErrInternalError, @"Cannot open temp file for streaming decode", nil);
        return;
      }

      int64_t totalSamplesWritten = 0;
      bool writeError = false;

      auto onChunk = [&](const float *samples, int count) {
        if (writeError) return;
        size_t written = fwrite(samples, sizeof(float), (size_t)count, outFile);
        if ((int)written != count) {
          writeError = true;
        } else {
          totalSamplesWritten += count;
        }
      };

      auto onProgress = [weakSelf, operationId](int64_t framesDecoded, int64_t totalEstimate, int percent) {
        SherpaOnnx *strongSelf = weakSelf;
        if (!strongSelf) return;
        dispatch_async(dispatch_get_main_queue(), ^{
          [strongSelf sendEventWithName:@"decodeProgress" body:@{
            @"operationId": operationId,
            @"framesDecoded": @((double)framesDecoded),
            @"totalFramesEstimate": @((double)totalEstimate),
            @"percent": @(percent),
          }];
        });
      };

      sherpa::AudioDecodeResult result;
      try {
        result = sherpa::decodeFile(path.c_str(), config, onChunk, onProgress, nullptr, *cancelFlag);
      } catch (const std::runtime_error &e) {
        fclose(outFile);
        unlink(f32Path.c_str());
        [readHandle cleanup];
        if (tmpPath) [[NSFileManager defaultManager] removeItemAtPath:tmpPath error:nil];
        {
          std::lock_guard<std::mutex> lock(g_pa_decodeCancelMutex);
          g_pa_decodeCancelFlags.erase(opId);
        }
        std::string msg = e.what();
        NSString *nsMsg = [NSString stringWithUTF8String:msg.c_str()];
        NSString *nsCode = @"DECODE_INTERNAL_ERROR";
        if (msg.find("DECODE_") == 0) {
          auto colonPos = msg.find(':');
          if (colonPos != std::string::npos) {
            nsCode = [NSString stringWithUTF8String:msg.substr(0, colonPos).c_str()];
          }
        }
        reject(nsCode, nsMsg, nil);
        return;
      }

      fclose(outFile);
      outFile = nullptr;

      [readHandle cleanup];
      if (tmpPath) [[NSFileManager defaultManager] removeItemAtPath:tmpPath error:nil];
      {
        std::lock_guard<std::mutex> lock(g_pa_decodeCancelMutex);
        g_pa_decodeCancelFlags.erase(opId);
      }

      if (writeError || totalSamplesWritten <= 0) {
        unlink(f32Path.c_str());
        reject(kPAErrFileReadError, @"Could not decode audio samples", nil);
        return;
      }

      int outputRate = config.targetSampleRate > 0 ? config.targetSampleRate : result.sourceSampleRate;

      long rawSize = (long)totalSamplesWritten * sizeof(float);
      std::shared_ptr<PaOfflineEntry> entry;
      if (rawSize >= kPaFileBackedThreshold) {
        // Large: mmap the already-written .f32 directly (zero heap copy)
        auto region = PaMmapRegion::mapFile(f32Path);
        if (region) {
          entry = std::make_shared<PaOfflineEntry>();
          entry->bufferId = bufferId;
          entry->sampleRate = outputRate;
          entry->channelCount = 1;
          entry->mmapRegion = std::move(region);
        }
      }
      if (!entry) {
        // Small or mmap failed: load into heap vector, delete temp file
        int fd = open(f32Path.c_str(), O_RDONLY);
        if (fd >= 0) {
          std::vector<float> samples((size_t)totalSamplesWritten);
          read(fd, samples.data(), (size_t)totalSamplesWritten * sizeof(float));
          close(fd);
          unlink(f32Path.c_str());
          entry = std::make_shared<PaOfflineEntry>();
          entry->bufferId = bufferId;
          entry->sampleRate = outputRate;
          entry->channelCount = 1;
          entry->samples = std::move(samples);
        } else {
          unlink(f32Path.c_str());
          reject(kPAErrInternalError, @"Failed to read decoded audio temp file", nil);
          return;
        }
      }

      {
        std::lock_guard<std::mutex> lock(g_pa_mutex);
        g_pa_offline[bufferId] = entry;
      }
      resolve(entry->toDict());
    } @catch (NSException *e) {
      {
        std::lock_guard<std::mutex> lock(g_pa_decodeCancelMutex);
        g_pa_decodeCancelFlags.erase(opId);
      }
      reject(kPAErrInternalError, e.reason, nil);
    }
  });
}

// ---- Offline: empty (output target for TTS) ----
- (void)createEmptyOfflineAudioBuffer:(double)sampleRate
                         channelCount:(NSNumber *)channelCount
                              resolve:(RCTPromiseResolveBlock)resolve
                               reject:(RCTPromiseRejectBlock)reject
{
  @try {
    if (sampleRate <= 0) { reject(kPAErrInvalidArgument, @"sampleRate must be > 0", nil); return; }
    int ch = channelCount ? [channelCount intValue] : 1;
    if (ch != 1) { reject(kPAErrInvalidArgument, @"Only mono (channelCount=1) is supported", nil); return; }

    std::string bufferId = pa_generateId("off");
    auto entry = std::make_shared<PaOfflineEntry>();
    entry->bufferId = bufferId;
    entry->sampleRate = (int)sampleRate;
    entry->channelCount = ch;
    // samples is empty — will be populated by TTS synthesis
    {
      std::lock_guard<std::mutex> lock(g_pa_mutex);
      g_pa_offline[bufferId] = entry;
    }
    resolve(entry->toDict());
  } @catch (NSException *e) {
    reject(kPAErrInternalError, e.reason, nil);
  }
}

// ---- Offline: from live ----
- (void)createOfflineAudioBufferFromLive:(NSString *)liveBufferId
                                    mode:(NSString *)mode
                                 resolve:(RCTPromiseResolveBlock)resolve
                                  reject:(RCTPromiseRejectBlock)reject
{
  @try {
    std::string liveId = [liveBufferId UTF8String];
    std::shared_ptr<PaLiveEntry> live;
    {
      std::lock_guard<std::mutex> lock(g_pa_mutex);
      auto it = g_pa_live.find(liveId);
      if (it == g_pa_live.end()) {
        reject(kPAErrBufferNotFound, @"Live buffer not found", nil);
        return;
      }
      live = it->second;
    }

    std::string modeStr = mode ? [mode UTF8String] : "fullIfSpooled";
    std::string bufferId = pa_generateId("off");

    std::shared_ptr<PaOfflineEntry> entry;

    if (modeStr == "fullIfSpooled" && live->hasActiveSpool && live->state == PaLiveEntry::FINISHED && !live->spoolPath.empty()) {
      PaWavHeader hdr;
      if (pa_parseWavHeader(live->spoolPath, hdr)) {
        // Stream WAV to .f32 temp file to avoid OOM on large spool files
        entry = pa_createOfflineFromWavSpoolFileStreaming(bufferId, live->spoolPath, hdr);
        if (!entry) {
          // Fallback: snapshot ring if streaming fails
          auto snapshot = live->snapshotRing();
          entry = pa_createEntryWithThreshold(bufferId, live->sampleRate, live->channelCount, snapshot);
        }
      } else {
        auto snapshot = live->snapshotRing();
        entry = pa_createEntryWithThreshold(bufferId, live->sampleRate, live->channelCount, snapshot);
      }
    } else {
      auto snapshot = live->snapshotRing();
      entry = pa_createEntryWithThreshold(bufferId, live->sampleRate, live->channelCount, snapshot);
    }

    {
      std::lock_guard<std::mutex> lock(g_pa_mutex);
      g_pa_offline[bufferId] = entry;
    }
    resolve(entry->toDict());
  } @catch (NSException *e) {
    reject(kPAErrInternalError, e.reason, nil);
  }
}

// ---- Live: create ----
- (void)createEmptyLiveAudioBuffer:(JS::NativeSherpaOnnx::SpecCreateEmptyLiveAudioBufferOptions &)options
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
  @try {
    int sr = (int)options.sampleRate();
    if (sr <= 0) { reject(kPAErrInvalidArgument, @"sampleRate must be > 0", nil); return; }
    int ch = options.channelCount().has_value() ? (int)options.channelCount().value() : 1;
    double windowSec = options.windowSeconds().has_value() ? options.windowSeconds().value() : 60.0;
    if (windowSec <= 0) { reject(kPAErrInvalidArgument, @"windowSeconds must be > 0", nil); return; }

    std::string spoolPath;
    bool spoolFloat = false;
    if (options.persistencePath()) {
      spoolPath = [options.persistencePath() UTF8String];
      if (options.persistenceFormat()) {
        NSString *fmt = options.persistenceFormat();
        spoolFloat = [fmt isEqualToString:@"wav_pcm_float"];
      }
    }

    bool emitAppendedEvents = options.emitAppendedEvents().has_value() ? options.emitAppendedEvents().value() : false;
    int appendEventMinIntervalMs = options.appendEventMinIntervalMs().has_value()
      ? std::max(0, (int)options.appendEventMinIntervalMs().value())
      : 0;

    std::string bufferId = pa_generateId("live");
    NSString *liveBufferId = [NSString stringWithUTF8String:bufferId.c_str()];
    __weak SherpaOnnx *weakSelf = self;

    auto onFramesAppended = [weakSelf, liveBufferId, sr](
      const std::string &source,
      int frameCount,
      int64_t totalSamplesWritten
    ) {
      SherpaOnnx *module = weakSelf;
      if (!module) return;

      NSMutableDictionary *payload = [NSMutableDictionary dictionary];
      payload[@"liveBufferId"] = liveBufferId ?: @"";
      payload[@"source"] = [NSString stringWithUTF8String:source.c_str()];
      payload[@"sampleRate"] = @(sr);
      payload[@"frameCount"] = @(frameCount);
      payload[@"totalSamplesWritten"] = @((double)totalSamplesWritten);

      dispatch_async(dispatch_get_main_queue(), ^{
        [module sendEventWithName:@"pipelineLiveAudioChunk" body:payload];
      });
    };

    auto entry = std::make_shared<PaLiveEntry>(
      bufferId,
      sr,
      ch,
      windowSec,
      spoolPath,
      spoolFloat,
      emitAppendedEvents,
      appendEventMinIntervalMs,
      onFramesAppended
    );
    {
      std::lock_guard<std::mutex> lock(g_pa_mutex);
      g_pa_live[bufferId] = entry;
    }
    resolve(entry->toDict());
  } @catch (NSException *e) {
    reject(kPAErrInternalError, e.reason, nil);
  }
}

// ---- Live: append offline ----
- (void)appendOfflineToLiveAudioBuffer:(NSString *)liveBufferId
                       offlineBufferId:(NSString *)offlineBufferId
                               resolve:(RCTPromiseResolveBlock)resolve
                                reject:(RCTPromiseRejectBlock)reject
{
  @try {
    std::string liveId = [liveBufferId UTF8String];
    std::string offId = [offlineBufferId UTF8String];
    std::shared_ptr<PaLiveEntry> live;
    std::shared_ptr<PaOfflineEntry> offline;
    {
      std::lock_guard<std::mutex> lock(g_pa_mutex);
      auto lit = g_pa_live.find(liveId);
      if (lit == g_pa_live.end()) { reject(kPAErrBufferNotFound, @"Live buffer not found", nil); return; }
      live = lit->second;
      auto oit = g_pa_offline.find(offId);
      if (oit == g_pa_offline.end()) { reject(kPAErrBufferNotFound, @"Offline buffer not found", nil); return; }
      offline = oit->second;
    }
    if (live->state != PaLiveEntry::RECORDING) {
      reject(kPAErrAlreadyFinalized, @"Live buffer is finalized", nil);
      return;
    }
    auto allSamples = offline->readAllSamples();
    live->appendSamples(allSamples.data(), allSamples.size(), offline->sampleRate, kPaAppendSourceAppendOffline);
    resolve(nil);
  } @catch (NSException *e) {
    reject(kPAErrInternalError, e.reason, nil);
  }
}

// ---- Live: finalize ----
- (void)finalizeLiveAudioBuffer:(NSString *)liveBufferId
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject
{
  @try {
    std::string liveId = [liveBufferId UTF8String];
    std::shared_ptr<PaLiveEntry> live;
    {
      std::lock_guard<std::mutex> lock(g_pa_mutex);
      auto it = g_pa_live.find(liveId);
      if (it == g_pa_live.end()) { reject(kPAErrBufferNotFound, @"Live buffer not found", nil); return; }
      live = it->second;
    }
    live->finalize_();
    resolve(nil);
  } @catch (NSException *e) {
    reject(kPAErrInternalError, e.reason, nil);
  }
}

// ---- Audio save helpers ----

static bool pa_validateSaveParams(const std::string &fmt, int rate,
                                   RCTPromiseRejectBlock reject) {
  static const std::set<std::string> supportedFormats = {"wav","mp3","flac","aac","m4a","opus","webm","mkv","ogg"};
  if (supportedFormats.find(fmt) == supportedFormats.end()) {
    reject(@"AUDIO_SAVE_UNSUPPORTED_FORMAT",
           [NSString stringWithFormat:@"Unsupported format: %s", fmt.c_str()], nil);
    return false;
  }
  if (rate < 0) {
    reject(@"AUDIO_SAVE_INVALID_SAMPLE_RATE", @"outputSampleRateHz must be >= 0", nil);
    return false;
  }
  if (fmt == "mp3" && rate != 0 && rate != 32000 && rate != 44100 && rate != 48000) {
    reject(@"AUDIO_SAVE_INVALID_SAMPLE_RATE",
           [NSString stringWithFormat:@"MP3 sample rate must be 32000, 44100, 48000, or 0. Got: %d", rate], nil);
    return false;
  }
  if ((fmt == "opus" || fmt == "ogg" || fmt == "webm" || fmt == "mkv") &&
      rate != 0 && rate != 8000 && rate != 12000 && rate != 16000 && rate != 24000 && rate != 48000) {
    reject(@"AUDIO_SAVE_INVALID_SAMPLE_RATE",
           [NSString stringWithFormat:@"Opus sample rate must be 8000, 12000, 16000, 24000, 48000, or 0. Got: %d", rate], nil);
    return false;
  }
  return true;
}

static void pa_cleanupOutputFile(NSString *path) {
  if (path) {
    [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
  }
}

static std::string pa_encodeViaPcm(
    const float *samples, int numSamples, int sampleRate, int channelCount,
    const char *outputPath, const char *format, int outputSampleRateHz,
    int bitrate, int quality, std::atomic<bool> &cancelFlag) {
  sherpa::AudioEncodeConfig config{};
  config.outputPath = outputPath;
  config.formatHint = format;
  config.inputSampleRate = sampleRate;
  config.inputChannelCount = channelCount;
  config.outputSampleRateHz = outputSampleRateHz;
  config.bitrate = bitrate;
  config.quality = quality;

  std::string errorOut;
  int totalFrames = numSamples / channelCount;
  auto session = sherpa::AudioEncodeSession::create(config, totalFrames, nullptr, cancelFlag, errorOut);
  if (!session) return errorOut;

  const int chunkFrames = 4096;
  int offset = 0;
  while (offset < totalFrames) {
    int chunk = std::min(chunkFrames, totalFrames - offset);
    std::string err = session->feedChunk(samples + offset * channelCount, chunk);
    if (!err.empty()) return err;
    offset += chunk;
  }
  return session->finish();
}

static std::string pa_encodeViaDecodeFile(
    const char *inputPath, const char *outputPath, const char *format,
    int outputSampleRateHz, int bitrate, int quality,
    std::atomic<bool> &cancelFlag) {
  // Batch decode the file first
  sherpa::AudioDecodeConfig decConfig{};
  decConfig.targetSampleRate = 0; // keep source rate
  decConfig.forceMono = true;
  decConfig.chunkSize = 8192;

  std::vector<float> allSamples;
  auto onChunk = [&allSamples](const float *samples, int frameCount) {
    allSamples.insert(allSamples.end(), samples, samples + frameCount);
  };

  sherpa::AudioDecodeResult decResult;
  try {
    decResult = sherpa::decodeFile(inputPath, decConfig, onChunk, nullptr, nullptr, cancelFlag);
  } catch (const std::exception &e) {
    return std::string("AUDIO_SAVE_SOURCE_NOT_FOUND: ") + e.what();
  }

  if (allSamples.empty()) {
    return "AUDIO_SAVE_SOURCE_NOT_FOUND: Decoded file is empty";
  }

  int srcRate = decResult.sourceSampleRate > 0 ? decResult.sourceSampleRate : 16000;
  return pa_encodeViaPcm(allSamples.data(), (int)allSamples.size(), srcRate, 1,
                         outputPath, format, outputSampleRateHz, bitrate, quality, cancelFlag);
}

// ---- Save audio buffer to file ----
- (void)saveAudioBufferToFile:(NSString *)bufferId
                  destination:(NSDictionary *)destination
                       format:(NSString *)format
           outputSampleRateHz:(double)outputSampleRateHz
                      bitrate:(double)bitrate
                      quality:(double)quality
                  operationId:(NSString *)operationId
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
  int rate = (int)outputSampleRateHz;
  std::string fmt = [[format lowercaseString] UTF8String];

  if (!pa_validateSaveParams(fmt, rate, reject)) return;

  // Register cancel flag
  auto cancelFlag = std::make_shared<std::atomic<bool>>(false);
  std::string opId = [operationId UTF8String];
  {
    std::lock_guard<std::mutex> lock(g_pa_saveCancelMutex);
    g_pa_saveCancelFlags[opId] = cancelFlag;
  }

  // Resolve destination
  NSString *errCode = nil, *errMsg = nil;
  FileIOWriteHandle *wh = [FileIOResolver resolveDestination:destination overwrite:YES
                                     createParentDirectories:NO error:&errCode message:&errMsg];
  if (!wh) {
    {
      std::lock_guard<std::mutex> lock(g_pa_saveCancelMutex);
      g_pa_saveCancelFlags.erase(opId);
    }
    reject(errCode, errMsg, nil);
    return;
  }

  NSString *outputPath = wh.filePath;
  NSString *outputKind = @"fs";
  NSString *resultPath = wh.resultPath;

  std::string bid = [bufferId UTF8String];
  std::string outputPathStr = [outputPath UTF8String];
  std::string err;

  std::lock_guard<std::mutex> lock(g_pa_mutex);

  // Offline buffer?
  if (bid.rfind("off_", 0) == 0) {
    auto it = g_pa_offline.find(bid);
    if (it == g_pa_offline.end()) {
      [wh cleanup]; pa_cleanupOutputFile(outputPath);
      { std::lock_guard<std::mutex> lk(g_pa_saveCancelMutex); g_pa_saveCancelFlags.erase(opId); }
      reject(@"AUDIO_SAVE_SOURCE_NOT_FOUND", @"Offline buffer not found", nil); return;
    }
    auto &entry = it->second;
    if (entry->numSamples() == 0) {
      [wh cleanup]; pa_cleanupOutputFile(outputPath);
      { std::lock_guard<std::mutex> lk(g_pa_saveCancelMutex); g_pa_saveCancelFlags.erase(opId); }
      reject(@"AUDIO_SAVE_BUFFER_EMPTY", @"Buffer is empty", nil); return;
    }

    {
      const float *ptr = entry->floatPtr();
      int n = entry->numSamples();
      err = pa_encodeViaPcm(ptr, n,
                             entry->sampleRate, entry->channelCount,
                             outputPathStr.c_str(), fmt.c_str(), rate,
                             (int)bitrate, (int)quality, *cancelFlag);
    }
  }
  // Live buffer?
  else if (bid.rfind("live_", 0) == 0) {
    auto it = g_pa_live.find(bid);
    if (it == g_pa_live.end()) {
      [wh cleanup]; pa_cleanupOutputFile(outputPath);
      { std::lock_guard<std::mutex> lk(g_pa_saveCancelMutex); g_pa_saveCancelFlags.erase(opId); }
      reject(@"AUDIO_SAVE_SOURCE_NOT_FOUND", @"Live buffer not found", nil); return;
    }
    auto &entry = it->second;
    if (entry->state != PaLiveEntry::FINISHED) {
      [wh cleanup]; pa_cleanupOutputFile(outputPath);
      { std::lock_guard<std::mutex> lk(g_pa_saveCancelMutex); g_pa_saveCancelFlags.erase(opId); }
      reject(@"AUDIO_SAVE_BUFFER_NOT_FINALIZED", @"Live buffer must be finalized before saving", nil); return;
    }
    if (entry->totalSamplesWritten == 0) {
      [wh cleanup]; pa_cleanupOutputFile(outputPath);
      { std::lock_guard<std::mutex> lk(g_pa_saveCancelMutex); g_pa_saveCancelFlags.erase(opId); }
      reject(@"AUDIO_SAVE_BUFFER_EMPTY", @"Buffer is empty", nil); return;
    }

    if (entry->hasActiveSpool) {
      err = pa_encodeViaDecodeFile(entry->spoolPath.c_str(), outputPathStr.c_str(), fmt.c_str(),
                                    rate, (int)bitrate, (int)quality, *cancelFlag);
    } else {
      auto snapshot = entry->snapshotRing();
      err = pa_encodeViaPcm(snapshot.data(), (int)snapshot.size(), entry->sampleRate, 1,
                             outputPathStr.c_str(), fmt.c_str(), rate,
                             (int)bitrate, (int)quality, *cancelFlag);
    }
  }
  else {
    [wh cleanup]; pa_cleanupOutputFile(outputPath);
    { std::lock_guard<std::mutex> lk(g_pa_saveCancelMutex); g_pa_saveCancelFlags.erase(opId); }
    reject(@"AUDIO_SAVE_SOURCE_NOT_FOUND", @"Invalid buffer ID prefix: expected off_ or live_", nil);
    return;
  }

  {
    std::lock_guard<std::mutex> lk(g_pa_saveCancelMutex);
    g_pa_saveCancelFlags.erase(opId);
  }

  if (!err.empty()) {
    [wh cleanup]; pa_cleanupOutputFile(outputPath);
    NSString *code = @"AUDIO_SAVE_ENCODE_ERROR";
    NSString *nsErr = [NSString stringWithUTF8String:err.c_str()];
    if ([nsErr containsString:@"CANCELLED"]) code = @"AUDIO_SAVE_CANCELLED";
    reject(code, nsErr, nil);
    return;
  }

  [wh cleanup];
  resolve(@{ @"outputKind": outputKind, @"outputPath": resultPath });
}

// ---- Save file as audio file (file-to-file, no buffer registry) ----
- (void)saveFileAsAudioFile:(NSDictionary *)source
                destination:(NSDictionary *)destination
                     format:(NSString *)format
         outputSampleRateHz:(double)outputSampleRateHz
                    bitrate:(double)bitrate
                    quality:(double)quality
                operationId:(NSString *)operationId
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
  int rate = (int)outputSampleRateHz;
  std::string fmt = [[format lowercaseString] UTF8String];

  if (!pa_validateSaveParams(fmt, rate, reject)) return;

  // Register cancel flag
  auto cancelFlag = std::make_shared<std::atomic<bool>>(false);
  std::string opId = [operationId UTF8String];
  {
    std::lock_guard<std::mutex> lock(g_pa_saveCancelMutex);
    g_pa_saveCancelFlags[opId] = cancelFlag;
  }

  // Resolve source
  NSString *srcErrCode = nil, *srcErrMsg = nil;
  FileIOReadHandle *rh = [FileIOResolver resolveSource:source error:&srcErrCode message:&srcErrMsg];
  if (!rh) {
    {
      std::lock_guard<std::mutex> lock(g_pa_saveCancelMutex);
      g_pa_saveCancelFlags.erase(opId);
    }
    reject(srcErrCode, srcErrMsg, nil);
    return;
  }
  NSString *inputPath = rh.filePath;

  // Resolve destination
  NSString *dstErrCode = nil, *dstErrMsg = nil;
  FileIOWriteHandle *wh = [FileIOResolver resolveDestination:destination overwrite:YES
                                     createParentDirectories:NO error:&dstErrCode message:&dstErrMsg];
  if (!wh) {
    [rh cleanup];
    {
      std::lock_guard<std::mutex> lock(g_pa_saveCancelMutex);
      g_pa_saveCancelFlags.erase(opId);
    }
    reject(dstErrCode, dstErrMsg, nil);
    return;
  }

  NSString *outputPath = wh.filePath;
  NSString *outputKind = @"fs";
  NSString *resultPath = wh.resultPath;

  std::string inputPathStr = [inputPath UTF8String];
  std::string outputPathStr = [outputPath UTF8String];

  std::string err = pa_encodeViaDecodeFile(inputPathStr.c_str(), outputPathStr.c_str(), fmt.c_str(),
                                            rate, (int)bitrate, (int)quality, *cancelFlag);

  {
    std::lock_guard<std::mutex> lk(g_pa_saveCancelMutex);
    g_pa_saveCancelFlags.erase(opId);
  }

  [rh cleanup];

  if (!err.empty()) {
    [wh cleanup]; pa_cleanupOutputFile(outputPath);
    NSString *code = @"AUDIO_SAVE_ENCODE_ERROR";
    NSString *nsErr = [NSString stringWithUTF8String:err.c_str()];
    if ([nsErr containsString:@"CANCELLED"]) code = @"AUDIO_SAVE_CANCELLED";
    reject(code, nsErr, nil);
    return;
  }

  [wh cleanup];
  resolve(@{ @"outputKind": outputKind, @"outputPath": resultPath });
}

// ---- Cancel audio save ----
- (void)cancelAudioSave:(NSString *)operationId
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  std::string opId = [operationId UTF8String];
  {
    std::lock_guard<std::mutex> lock(g_pa_saveCancelMutex);
    auto it = g_pa_saveCancelFlags.find(opId);
    if (it != g_pa_saveCancelFlags.end()) {
      it->second->store(true);
    }
  }
  resolve(nil);
}

// ---- Info ----
- (void)getPipelineAudioBufferInfo:(NSString *)bufferId
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
  std::string bid = [bufferId UTF8String];
  std::lock_guard<std::mutex> lock(g_pa_mutex);
  auto offIt = g_pa_offline.find(bid);
  if (offIt != g_pa_offline.end()) {
    resolve(offIt->second->toDict());
    return;
  }
  auto liveIt = g_pa_live.find(bid);
  if (liveIt != g_pa_live.end()) {
    resolve(liveIt->second->toDict());
    return;
  }
  reject(kPAErrBufferNotFound, @"Buffer not found", nil);
}

// ---- Release ----
- (void)releasePipelineAudioBuffer:(NSString *)bufferId
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
  std::string bid = [bufferId UTF8String];
  std::lock_guard<std::mutex> lock(g_pa_mutex);
  auto offIt = g_pa_offline.find(bid);
  if (offIt != g_pa_offline.end()) {
    offIt->second->release();
    g_pa_offline.erase(offIt);
    resolve(nil);
    return;
  }
  auto liveIt = g_pa_live.find(bid);
  if (liveIt != g_pa_live.end()) {
    liveIt->second->release();
    g_pa_live.erase(liveIt);
    resolve(nil);
    return;
  }
  resolve(nil); // idempotent
}

// ---- File Ingest to Live Buffer ----
- (void)startFileIngestToLiveBuffer:(NSString *)liveBufferId
                             source:(NSDictionary *)source
                   targetSampleRateHz:(double)targetSampleRateHz
                          forceMono:(BOOL)forceMono
                       autoFinalize:(BOOL)autoFinalize
                        operationId:(NSString *)operationId
                            resolve:(RCTPromiseResolveBlock)resolve
                             reject:(RCTPromiseRejectBlock)reject
{
  std::string liveBufId = [liveBufferId UTF8String];
  std::string opId = [operationId UTF8String];

  // Validate live buffer
  auto liveEntry = pa_get_live_entry(liveBufId);
  if (!liveEntry) {
    reject(kPAErrBufferNotFound, @"Live buffer not found", nil);
    return;
  }
  if (liveEntry->state != PaLiveEntry::RECORDING) {
    reject(kPAErrInvalidState, @"Live buffer must be in RECORDING state for file ingest", nil);
    return;
  }

  // Ensure spool is active — create a temporary one if the buffer was created without persistencePath
  if (!liveEntry->hasActiveSpool) {
    NSString *tmpSpoolPath = [NSTemporaryDirectory() stringByAppendingPathComponent:
      [NSString stringWithFormat:@"ingest_spool_%@.wav", [[NSUUID UUID] UUIDString]]];
    liveEntry->enableSpool([tmpSpoolPath UTF8String], false, true);
    if (!liveEntry->hasActiveSpool) {
      reject(@"AUDIO_SPOOL_ERROR", @"Failed to create temporary spool for file ingest", nil);
      return;
    }
  }

  // Register cancel flag + ingest status
  auto cancelFlag = std::make_shared<std::atomic<bool>>(false);
  std::string ingestId = pa_generateId("ingest");
  {
    std::lock_guard<std::mutex> lock(g_pa_decodeCancelMutex);
    g_pa_decodeCancelFlags[opId] = cancelFlag;
  }
  auto status = std::make_shared<PaFileIngestStatus>();
  {
    std::lock_guard<std::mutex> lock(g_pa_fileIngestMutex);
    g_pa_fileIngestStatuses[ingestId] = status;
  }

  // Resolve file source
  NSString *errCode = nil, *errMsg = nil;
  FileIOReadHandle *readHandle = [FileIOResolver resolveSource:source error:&errCode message:&errMsg];
  if (!readHandle) {
    {
      std::lock_guard<std::mutex> lock(g_pa_decodeCancelMutex);
      g_pa_decodeCancelFlags.erase(opId);
    }
    {
      std::lock_guard<std::mutex> lock(g_pa_fileIngestMutex);
      g_pa_fileIngestStatuses.erase(ingestId);
    }
    reject(errCode, errMsg, nil);
    return;
  }

  NSString *sourcePath = nil;
  NSString *tmpPath = nil;
  if (readHandle.isFilePath) {
    sourcePath = readHandle.filePath;
  } else {
    tmpPath = [NSTemporaryDirectory() stringByAppendingPathComponent:
               [NSString stringWithFormat:@"fileio_buf_%@", [[NSUUID UUID] UUIDString]]];
    NSOutputStream *out = [NSOutputStream outputStreamToFileAtPath:tmpPath append:NO];
    [out open];
    [readHandle.stream open];
    uint8_t buf[65536];
    NSInteger bytesRead;
    while ((bytesRead = [readHandle.stream read:buf maxLength:sizeof(buf)]) > 0) {
      [out write:buf maxLength:bytesRead];
    }
    [out close];
    sourcePath = tmpPath;
  }

  // Resolve immediately with ingestId
  resolve(@{@"ingestId": [NSString stringWithUTF8String:ingestId.c_str()]});

  __weak SherpaOnnx *weakSelf = self;
  std::string path = [sourcePath UTF8String];

  dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
    int srcSampleRate = 0;
    int srcChannels = 0;

    try {
      sherpa::AudioDecodeConfig config;
      config.targetSampleRate = (int)targetSampleRateHz;
      config.forceMono = forceMono;
      config.chunkSize = 8192;

      auto onChunk = [&liveEntry, &status](const float *samples, int count) {
        liveEntry->appendSamples(samples, count, liveEntry->sampleRate, kPaAppendSourceFileIngest);
        status->framesIngested += count;
      };

      auto onStreamInfo = [&srcSampleRate, &srcChannels](int sr, int ch) {
        srcSampleRate = sr;
        srcChannels = ch;
      };

      auto onProgress = [weakSelf, operationId, &srcSampleRate, &srcChannels, &status](
          int64_t framesDecoded, int64_t totalEstimate, int percent) {
        status->totalFramesEstimate = totalEstimate;
        status->percent = percent;
        SherpaOnnx *strongSelf = weakSelf;
        if (!strongSelf) return;
        dispatch_async(dispatch_get_main_queue(), ^{
          [strongSelf sendEventWithName:@"decodeProgress" body:@{
            @"operationId": operationId,
            @"framesDecoded": @((double)framesDecoded),
            @"totalFramesEstimate": @((double)totalEstimate),
            @"percent": @(percent),
            @"sourceSampleRate": @(srcSampleRate),
            @"sourceChannels": @(srcChannels),
          }];
        });
      };

      auto result = sherpa::decodeFile(path.c_str(), config, onChunk, onProgress, onStreamInfo, *cancelFlag);
      srcSampleRate = result.sourceSampleRate;
      srcChannels = result.sourceChannels;

      if (autoFinalize) {
        liveEntry->finalize_();
      }

      status->isRunning = false;
      status->percent = 100;

      SherpaOnnx *strongSelf = weakSelf;
      if (strongSelf) {
        dispatch_async(dispatch_get_main_queue(), ^{
          [strongSelf sendEventWithName:@"decodeComplete" body:@{
            @"operationId": operationId,
            @"success": @YES,
            @"totalFramesIngested": @((double)status->framesIngested),
            @"sourceSampleRate": @(srcSampleRate),
            @"sourceChannels": @(srcChannels),
            @"autoFinalized": @(autoFinalize),
          }];
        });
      }
    } catch (const std::runtime_error &e) {
      std::string msg = e.what();
      status->isRunning = false;
      status->error = msg;

      NSString *nsMsg = [NSString stringWithUTF8String:msg.c_str()];
      NSString *nsCode = @"DECODE_INTERNAL_ERROR";
      if (msg.find("DECODE_") == 0) {
        auto colonPos = msg.find(':');
        if (colonPos != std::string::npos) {
          nsCode = [NSString stringWithUTF8String:msg.substr(0, colonPos).c_str()];
        }
      }

      SherpaOnnx *strongSelf = weakSelf;
      if (strongSelf) {
        dispatch_async(dispatch_get_main_queue(), ^{
          [strongSelf sendEventWithName:@"decodeComplete" body:@{
            @"operationId": operationId,
            @"success": @NO,
            @"error": nsMsg,
            @"errorCode": nsCode,
          }];
        });
      }
    } catch (...) {
      status->isRunning = false;
      status->error = "Unknown error";

      SherpaOnnx *strongSelf = weakSelf;
      if (strongSelf) {
        dispatch_async(dispatch_get_main_queue(), ^{
          [strongSelf sendEventWithName:@"decodeComplete" body:@{
            @"operationId": operationId,
            @"success": @NO,
            @"error": @"Unknown error during streaming decode",
            @"errorCode": @"DECODE_INTERNAL_ERROR",
          }];
        });
      }
    }

    // Cleanup
    {
      std::lock_guard<std::mutex> lock(g_pa_decodeCancelMutex);
      g_pa_decodeCancelFlags.erase(opId);
    }
    [readHandle cleanup];
    if (tmpPath) [[NSFileManager defaultManager] removeItemAtPath:tmpPath error:nil];
  });
}

// ---- File Ingest Status ----
- (void)getFileIngestStatus:(NSString *)ingestId
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
  std::string iId = [ingestId UTF8String];
  std::shared_ptr<PaFileIngestStatus> status;
  {
    std::lock_guard<std::mutex> lock(g_pa_fileIngestMutex);
    auto it = g_pa_fileIngestStatuses.find(iId);
    if (it != g_pa_fileIngestStatuses.end()) {
      status = it->second;
    }
  }

  if (!status) {
    resolve(@{
      @"isRunning": @NO,
      @"framesIngested": @(0.0),
      @"totalFramesEstimate": @(0.0),
      @"percent": @(0),
      @"error": [NSString stringWithFormat:@"Ingest not found: %@", ingestId],
    });
    return;
  }

  NSMutableDictionary *dict = [NSMutableDictionary dictionaryWithDictionary:@{
    @"isRunning": @(status->isRunning),
    @"framesIngested": @((double)status->framesIngested),
    @"totalFramesEstimate": @((double)status->totalFramesEstimate),
    @"percent": @(status->percent),
  }];
  if (!status->error.empty()) {
    dict[@"error"] = [NSString stringWithUTF8String:status->error.c_str()];
  }
  resolve(dict);
}

// ---- Cancel Decode ----
- (void)cancelDecode:(NSString *)operationId
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
  std::string opId = [operationId UTF8String];
  {
    std::lock_guard<std::mutex> lock(g_pa_decodeCancelMutex);
    auto it = g_pa_decodeCancelFlags.find(opId);
    if (it != g_pa_decodeCancelFlags.end()) {
      it->second->store(true);
    }
  }
  resolve(nil);
}

#endif

@end
