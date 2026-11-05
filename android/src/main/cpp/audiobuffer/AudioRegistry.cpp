#include "AudioRegistry.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <dirent.h>
#include <fstream>
#include <random>
#include <sstream>
#include <sys/stat.h>

// Always weak so SegEngine.cpp can provide the strong definitions.
#if defined(__GNUC__) || defined(__clang__)
#define PA_WEAK_STUB __attribute__((weak))
#else
#define PA_WEAK_STUB
#endif

PA_WEAK_STUB void seg_engine_on_audio_append(const std::string & /*liveBufferId*/,
                                             const float * /*samples*/, size_t /*count*/,
                                             int /*sampleRate*/,
                                             int64_t /*totalSamplesWritten*/) {}
PA_WEAK_STUB void seg_engine_on_buffer_finalized(const std::string & /*bufferId*/) {}
PA_WEAK_STUB void seg_engine_on_buffer_released(const std::string & /*bufferId*/) {}

std::unordered_map<std::string, std::shared_ptr<PaOfflineEntry>> g_pa_offline;
std::unordered_map<std::string, std::shared_ptr<PaLiveEntry>> g_pa_live;
std::unordered_set<std::string> g_pa_invalidated_live_ids;
std::mutex g_pa_mutex;

namespace {

std::mutex g_pa_config_mutex;
std::string g_pa_cache_dir = "/tmp";
bool g_pa_threshold_configured = false;

enum class PaDeviceRamClass { LOW, MID, HIGH, VERY_HIGH };
enum class PaThresholdPathType { FILE_ORIGIN, HEAP_ORIGIN };

struct PaThresholdSnapshot {
  PaDeviceRamClass ramClass = PaDeviceRamClass::MID;
  long fileOriginThresholdBytes = 8L * 1024L * 1024L;
  long heapOriginThresholdBytes = 12L * 1024L * 1024L;
};

constexpr long kPaMb = 1024L * 1024L;
constexpr long kPaMinThresholdBytes = 4L * kPaMb;
constexpr long kPaMaxThresholdBytes = 32L * kPaMb;
constexpr uint64_t kPaLowRamMaxBytes = 3ULL * 1024ULL * 1024ULL * 1024ULL;
constexpr uint64_t kPaMidRamMaxBytes = 6ULL * 1024ULL * 1024ULL * 1024ULL;
constexpr uint64_t kPaHighRamMaxBytes = 12ULL * 1024ULL * 1024ULL * 1024ULL;
constexpr double kPaFileOriginBaseMb = 8.0;
constexpr double kPaHeapOriginBaseMb = 12.0;
constexpr double kPaMultiplierLow = 0.75;
constexpr double kPaMultiplierMid = 1.0;
constexpr double kPaMultiplierHigh = 1.5;
constexpr double kPaMultiplierVeryHigh = 2.0;

PaThresholdSnapshot gPaThresholdSnapshot;
std::unordered_map<std::string, std::shared_ptr<std::atomic<bool>>> g_pa_decodeCancelFlags;
std::mutex g_pa_decodeCancelMutex;

PaDeviceRamClass classifyRam(uint64_t totalRamBytes) {
  if (totalRamBytes <= kPaLowRamMaxBytes) return PaDeviceRamClass::LOW;
  if (totalRamBytes <= kPaMidRamMaxBytes) return PaDeviceRamClass::MID;
  if (totalRamBytes <= kPaHighRamMaxBytes) return PaDeviceRamClass::HIGH;
  return PaDeviceRamClass::VERY_HIGH;
}

double multiplierFor(PaDeviceRamClass ramClass) {
  switch (ramClass) {
    case PaDeviceRamClass::LOW:
      return kPaMultiplierLow;
    case PaDeviceRamClass::MID:
      return kPaMultiplierMid;
    case PaDeviceRamClass::HIGH:
      return kPaMultiplierHigh;
    case PaDeviceRamClass::VERY_HIGH:
      return kPaMultiplierVeryHigh;
  }
  return kPaMultiplierMid;
}

long clampThreshold(long bytes) {
  return std::max(kPaMinThresholdBytes, std::min(kPaMaxThresholdBytes, bytes));
}

long computeThresholdBytes(PaThresholdPathType pathType) {
  switch (pathType) {
    case PaThresholdPathType::FILE_ORIGIN:
      return gPaThresholdSnapshot.fileOriginThresholdBytes;
    case PaThresholdPathType::HEAP_ORIGIN:
      return gPaThresholdSnapshot.heapOriginThresholdBytes;
  }
  return gPaThresholdSnapshot.heapOriginThresholdBytes;
}

void sweepDirByPrefix(const std::string &dir, const char *prefix, const char *suffix,
                      int maxAgeSec) {
  DIR *d = opendir(dir.c_str());
  if (!d) return;
  const auto now = std::chrono::system_clock::now();
  const auto nowSec =
      std::chrono::duration_cast<std::chrono::seconds>(now.time_since_epoch()).count();
  size_t prefixLen = std::strlen(prefix);
  size_t suffixLen = suffix ? std::strlen(suffix) : 0;
  while (dirent *ent = readdir(d)) {
    const char *name = ent->d_name;
    if (std::strncmp(name, prefix, prefixLen) != 0) continue;
    if (suffix) {
      size_t nlen = std::strlen(name);
      if (nlen < suffixLen || std::strcmp(name + nlen - suffixLen, suffix) != 0) continue;
    }
    std::string full = dir + "/" + name;
    struct stat st {};
    if (stat(full.c_str(), &st) != 0) continue;
    if (nowSec - (long)st.st_mtime > maxAgeSec) {
      unlink(full.c_str());
    }
  }
  closedir(d);
}

}  // namespace

void pa_configure_cache_dir(const std::string &cacheDir) {
  std::lock_guard<std::mutex> lock(g_pa_config_mutex);
  if (!cacheDir.empty()) g_pa_cache_dir = cacheDir;
}

// Perf keep: docs/internal/audiobuffer/performance/audiobuffer-perf-plan.md (B — mmap threshold).
void pa_configure_threshold(uint64_t totalRamBytes) {
  std::lock_guard<std::mutex> lock(g_pa_config_mutex);
  PaDeviceRamClass ramClass = classifyRam(totalRamBytes);
  double multiplier = multiplierFor(ramClass);
  gPaThresholdSnapshot.ramClass = ramClass;
  gPaThresholdSnapshot.fileOriginThresholdBytes =
      clampThreshold((long)(kPaFileOriginBaseMb * multiplier * (double)kPaMb));
  gPaThresholdSnapshot.heapOriginThresholdBytes =
      clampThreshold((long)(kPaHeapOriginBaseMb * multiplier * (double)kPaMb));
  g_pa_threshold_configured = true;
}

std::string pa_temp_dir() {
  std::lock_guard<std::mutex> lock(g_pa_config_mutex);
  return g_pa_cache_dir;
}

std::string pa_generate_id(const char *prefix) {
  // Match TS dashed UUID; do not use unpadded std::hex.
  static thread_local std::mt19937_64 rng{std::random_device{}()};
  std::uniform_int_distribution<uint64_t> dist;
  const uint64_t a = dist(rng);
  const uint64_t b = dist(rng);
  char buf[64];
  std::snprintf(buf, sizeof(buf), "%s_%08x-%04x-%04x-%04x-%012llx", prefix,
                static_cast<unsigned>(a >> 32), static_cast<unsigned>((a >> 16) & 0xffffu),
                static_cast<unsigned>(a & 0xffffu), static_cast<unsigned>((b >> 48) & 0xffffu),
                static_cast<unsigned long long>(b & 0xffffffffffffULL));
  return std::string(buf);
}

// Perf keep: docs/internal/audiobuffer/performance/audiobuffer-perf-plan.md (B — mmap threshold).
std::shared_ptr<PaOfflineEntry> pa_create_entry_with_threshold(const std::string &bufferId,
                                                               int sampleRate, int channelCount,
                                                               std::vector<float> &samples) {
  if (!g_pa_threshold_configured) {
    pa_configure_threshold(6ULL * 1024ULL * 1024ULL * 1024ULL);
  }
  auto entry = std::make_shared<PaOfflineEntry>();
  entry->bufferId = bufferId;
  entry->sampleRate = sampleRate;
  entry->channelCount = channelCount;

  long rawSize = (long)samples.size() * (long)sizeof(float);
  long threshold = computeThresholdBytes(PaThresholdPathType::HEAP_ORIGIN);
  if (rawSize >= threshold) {
    auto region =
        PaMmapRegion::createFromSamples(samples.data(), samples.size(), pa_temp_dir(), bufferId);
    if (region) {
      entry->mmapRegion = std::move(region);
      return entry;
    }
  }
  entry->samples = std::move(samples);
  return entry;
}

void pa_upgradeToMmapIfNeeded(const std::string &bufferId) {
  std::shared_ptr<PaOfflineEntry> entry;
  {
    std::lock_guard<std::mutex> lock(g_pa_mutex);
    auto it = g_pa_offline.find(bufferId);
    if (it == g_pa_offline.end()) return;
    entry = it->second;
  }
  if (entry->isMmapBacked()) return;
  long rawSize = (long)entry->samples.size() * (long)sizeof(float);
  long threshold = computeThresholdBytes(PaThresholdPathType::HEAP_ORIGIN);
  if (rawSize < threshold) return;

  auto region = PaMmapRegion::createFromSamples(entry->samples.data(), entry->samples.size(),
                                                pa_temp_dir(), bufferId);
  if (!region) return;

  auto upgraded = std::make_shared<PaOfflineEntry>();
  upgraded->bufferId = entry->bufferId;
  upgraded->sampleRate = entry->sampleRate;
  upgraded->channelCount = entry->channelCount;
  upgraded->mmapRegion = std::move(region);

  std::lock_guard<std::mutex> lock(g_pa_mutex);
  auto it = g_pa_offline.find(bufferId);
  if (it == g_pa_offline.end() || it->second != entry || it->second->isMmapBacked()) return;
  it->second = upgraded;
}

void pa_register_decode_cancel(const std::string &opId,
                               std::shared_ptr<std::atomic<bool>> flag) {
  std::lock_guard<std::mutex> lock(g_pa_decodeCancelMutex);
  g_pa_decodeCancelFlags[opId] = std::move(flag);
}

void pa_unregister_decode_cancel(const std::string &opId) {
  std::lock_guard<std::mutex> lock(g_pa_decodeCancelMutex);
  g_pa_decodeCancelFlags.erase(opId);
}

std::shared_ptr<std::atomic<bool>> pa_get_decode_cancel(const std::string &opId) {
  std::lock_guard<std::mutex> lock(g_pa_decodeCancelMutex);
  auto it = g_pa_decodeCancelFlags.find(opId);
  if (it == g_pa_decodeCancelFlags.end()) return nullptr;
  return it->second;
}

bool pa_create_offline_from_f32_file(const std::string &f32Path, int sampleRate, int channelCount,
                                     std::string *bufferIdOut, std::string *errorCode,
                                     std::string *errorMessage) {
  if (!bufferIdOut || !errorCode || !errorMessage) return false;
  struct stat st {};
  if (stat(f32Path.c_str(), &st) != 0 || st.st_size <= 0) {
    *errorCode = "VIDEO_SPOOL_IO";
    *errorMessage = "extract f32 missing";
    return false;
  }
  int numSamples = (int)(st.st_size / (off_t)sizeof(float));
  if (numSamples <= 0) {
    *errorCode = "VIDEO_AUDIO_DECODE_FAILED";
    *errorMessage = "no samples in range";
    return false;
  }
  std::string bufferId = pa_generate_id("off");
  auto entry = std::make_shared<PaOfflineEntry>();
  entry->bufferId = bufferId;
  entry->sampleRate = sampleRate;
  entry->channelCount = channelCount;
  long threshold = computeThresholdBytes(PaThresholdPathType::FILE_ORIGIN);
  if ((long)st.st_size >= threshold) {
    auto region = PaMmapRegion::mapFile(f32Path, 0, true);
    if (!region) {
      unlink(f32Path.c_str());
      *errorCode = "VIDEO_SPOOL_IO";
      *errorMessage = "mmap extract f32";
      return false;
    }
    entry->mmapRegion = std::move(region);
  } else {
    std::vector<float> samples((size_t)numSamples);
    FILE *rf = fopen(f32Path.c_str(), "rb");
    if (!rf) {
      unlink(f32Path.c_str());
      *errorCode = "VIDEO_SPOOL_IO";
      *errorMessage = "read extract f32";
      return false;
    }
    size_t nread = fread(samples.data(), sizeof(float), (size_t)numSamples, rf);
    fclose(rf);
    unlink(f32Path.c_str());
    if (nread != (size_t)numSamples) {
      *errorCode = "VIDEO_SPOOL_IO";
      *errorMessage = "short extract f32";
      return false;
    }
    entry->samples = std::move(samples);
  }
  {
    std::lock_guard<std::mutex> lock(g_pa_mutex);
    g_pa_offline[bufferId] = entry;
  }
  *bufferIdOut = bufferId;
  return true;
}

/**
 * Live spool → offline via mmap @ WAV offset 44 (no WAV→.f32 double copy).
 * Perf keep: docs/internal/audiobuffer/performance/audiobuffer-perf-plan.md (C #9 / B — transfer mmap).
 */
std::shared_ptr<PaOfflineEntry> pa_create_offline_from_transferred_wav_spool(
    const std::string &bufferId, const std::string &spoolPath, int sampleRate, int channelCount) {
  struct stat st {};
  if (stat(spoolPath.c_str(), &st) != 0 || st.st_size <= 44) return nullptr;
  int64_t payloadBytes = static_cast<int64_t>(st.st_size) - 44;
  if (payloadBytes <= 0 || (payloadBytes % (int64_t)sizeof(float)) != 0) return nullptr;

  auto entry = std::make_shared<PaOfflineEntry>();
  entry->bufferId = bufferId;
  entry->sampleRate = sampleRate;
  entry->channelCount = channelCount;
  long threshold = computeThresholdBytes(PaThresholdPathType::FILE_ORIGIN);
  if (st.st_size >= threshold) {
    auto region = PaMmapRegion::mapFile(spoolPath, 44, true);
    if (!region) return nullptr;
    entry->mmapRegion = std::move(region);
    return entry;
  }
  std::ifstream wavFile(spoolPath, std::ios::binary);
  if (!wavFile) return nullptr;
  wavFile.seekg(44);
  if (!wavFile) return nullptr;
  int sampleCount = (int)(payloadBytes / (int64_t)sizeof(float));
  std::vector<float> tmp((size_t)sampleCount);
  wavFile.read(reinterpret_cast<char *>(tmp.data()), static_cast<std::streamsize>(payloadBytes));
  if (!wavFile && !wavFile.eof()) return nullptr;
  entry->samples = std::move(tmp);
  unlink(spoolPath.c_str());
  return entry;
}

void pa_sweepOrphanedTempFiles(int maxAgeSec) {
  sweepDirByPrefix(pa_temp_dir(), "pa_off_", ".f32", maxAgeSec);
}

void pa_sweepOrphanedOrchestrationFiles(int maxAgeSec) {
  sweepDirByPrefix(pa_temp_dir(), "orch_", nullptr, maxAgeSec);
}

void pa_cleanupOrphanedOrchestrationFiles(int maxAgeSec) {
  pa_sweepOrphanedOrchestrationFiles(maxAgeSec);
}

// Short g_pa_mutex hold: return shared_ptr so append/drain run outside the registry lock.
// Perf keep: docs/internal/audiobuffer/performance/audiobuffer-perf-plan.md (C #11).
std::shared_ptr<PaLiveEntry> pa_get_live_entry(const std::string &bufferId) {
  std::lock_guard<std::mutex> lock(g_pa_mutex);
  auto it = g_pa_live.find(bufferId);
  if (it == g_pa_live.end()) return nullptr;
  return it->second;
}

bool pa_is_live_invalidated(const std::string &bufferId) {
  std::lock_guard<std::mutex> lock(g_pa_mutex);
  return g_pa_invalidated_live_ids.find(bufferId) != g_pa_invalidated_live_ids.end();
}

std::shared_ptr<PaOfflineEntry> pa_get_offline_entry(const std::string &bufferId) {
  std::lock_guard<std::mutex> lock(g_pa_mutex);
  auto it = g_pa_offline.find(bufferId);
  if (it == g_pa_offline.end()) return nullptr;
  return it->second;
}

bool pa_acquire_offline_sample_view(const std::string &bufferId, int startSample,
                                    int endSampleExclusive, PaOfflineSampleView *out,
                                    std::string *errorCode, std::string *errorMessage) {
  if (!out) {
    if (errorCode) *errorCode = "AUDIO_INVALID_ARGUMENT";
    if (errorMessage) *errorMessage = "out must be non-null";
    return false;
  }
  *out = PaOfflineSampleView{};

  const bool full = startSample < 0 && endSampleExclusive < 0;
  if (!full && (startSample < 0 || endSampleExclusive < 0)) {
    if (errorCode) *errorCode = "AUDIO_INVALID_ARGUMENT";
    if (errorMessage) {
      *errorMessage =
          "startSample and endSampleExclusive must both be >= 0, or both < 0 for the full buffer";
    }
    return false;
  }
  if (!full && startSample > endSampleExclusive) {
    if (errorCode) *errorCode = "AUDIO_INVALID_ARGUMENT";
    if (errorMessage) *errorMessage = "startSample must be <= endSampleExclusive";
    return false;
  }

  auto entry = pa_get_offline_entry(bufferId);
  if (!entry) {
    if (errorCode) *errorCode = "AUDIO_BUFFER_NOT_FOUND";
    if (errorMessage) *errorMessage = "Offline buffer not found";
    return false;
  }

  const int total = entry->numSamples();
  int start = 0;
  int end = total;
  if (!full) {
    start = std::min(std::max(startSample, 0), total);
    end = std::min(std::max(endSampleExclusive, 0), total);
    if (start > end) start = end;
  }
  const int count = std::max(0, end - start);
  const float *base = entry->floatPtr();
  out->entry = std::move(entry);
  out->sampleRate = out->entry->sampleRate;
  out->count = static_cast<size_t>(count);
  out->data = (count > 0 && base != nullptr) ? base + start : nullptr;
  return true;
}

bool pa_read_offline_samples(const std::string &bufferId, std::vector<float> *samples,
                             int *sampleRate) {
  if (!samples || !sampleRate) return false;
  std::shared_ptr<PaOfflineEntry> entry;
  {
    std::lock_guard<std::mutex> lock(g_pa_mutex);
    auto it = g_pa_offline.find(bufferId);
    if (it == g_pa_offline.end()) return false;
    entry = it->second;
  }
  *sampleRate = entry->sampleRate;
  *samples = entry->readAllSamples();
  return true;
}

bool pa_create_offline_from_samples(const float *samples, size_t count, int sampleRate,
                                    int channelCount, std::string *json, std::string *errorCode,
                                    std::string *errorMessage) {
  if (!samples || count == 0 || sampleRate <= 0 || channelCount <= 0) {
    if (errorCode) *errorCode = "AUDIO_INVALID_ARGUMENT";
    if (errorMessage) *errorMessage = "Invalid audio samples or format";
    return false;
  }
  std::string bufferId = pa_generate_id("off");
  std::vector<float> owned(samples, samples + count);
  auto entry = pa_create_entry_with_threshold(bufferId, sampleRate, channelCount, owned);
  if (!entry) {
    if (errorCode) *errorCode = "AUDIO_INTERNAL_ERROR";
    if (errorMessage) *errorMessage = "Failed to create offline audio entry";
    return false;
  }
  {
    std::lock_guard<std::mutex> lock(g_pa_mutex);
    g_pa_offline[bufferId] = entry;
  }
  if (json) {
    *json = std::string("{\"bufferId\":\"") + bufferId +
            "\",\"kind\":\"offlinePcmBuffer\",\"state\":\"immutable\",\"sampleRate\":" +
            std::to_string(entry->sampleRate) + ",\"channelCount\":" +
            std::to_string(entry->channelCount) +
            ",\"numSamples\":" + std::to_string(entry->numSamples()) +
            ",\"durationMs\":" + std::to_string(entry->durationMs()) + "}";
  }
  return true;
}

bool pa_get_offline_samples_slice(const std::string &bufferId, int startFrame, int frameCount,
                                  std::vector<float> *out, std::string *errorCode,
                                  std::string *errorMessage) {
  if (!out) return false;
  if (startFrame < 0 || frameCount < 0) {
    if (errorCode) *errorCode = "AUDIO_INVALID_ARGUMENT";
    if (errorMessage) *errorMessage = "startFrame/frameCount must be >= 0";
    return false;
  }
  std::shared_ptr<PaOfflineEntry> entry;
  {
    std::lock_guard<std::mutex> lock(g_pa_mutex);
    auto it = g_pa_offline.find(bufferId);
    if (it == g_pa_offline.end()) {
      if (errorCode) *errorCode = "AUDIO_BUFFER_NOT_FOUND";
      if (errorMessage) *errorMessage = "Offline buffer not found";
      return false;
    }
    entry = it->second;
  }
  *out = entry->readSlice(startFrame, frameCount);
  return true;
}

bool pa_copy_offline_samples(const std::string &bufferId, int startSample, float *dest,
                             int maxSamples, int *outCopied, std::string *errorCode,
                             std::string *errorMessage) {
  if (outCopied) *outCopied = 0;
  if (!dest) {
    if (errorCode) *errorCode = "AUDIO_INVALID_ARGUMENT";
    if (errorMessage) *errorMessage = "dest must be non-null";
    return false;
  }
  if (startSample < 0 || maxSamples < 0) {
    if (errorCode) *errorCode = "AUDIO_INVALID_ARGUMENT";
    if (errorMessage) *errorMessage = "startSample/maxSamples must be >= 0";
    return false;
  }
  if (maxSamples == 0) {
    return true;
  }
  std::shared_ptr<PaOfflineEntry> entry;
  {
    std::lock_guard<std::mutex> lock(g_pa_mutex);
    auto it = g_pa_offline.find(bufferId);
    if (it == g_pa_offline.end()) {
      if (errorCode) *errorCode = "AUDIO_BUFFER_NOT_FOUND";
      if (errorMessage) *errorMessage = "Offline buffer not found";
      return false;
    }
    entry = it->second;
  }
  const int total = entry->numSamples();
  const int safeStart = startSample;
  if (safeStart >= total) {
    return true;
  }
  const int actual = std::min(maxSamples, total - safeStart);
  const float *base = entry->floatPtr();
  if (!base) {
    return true;
  }
  std::memcpy(dest, base + safeStart, static_cast<size_t>(actual) * sizeof(float));
  if (outCopied) *outCopied = actual;
  return true;
}

bool pa_get_live_samples_slice(const std::string &bufferId, int startFrame, int frameCount,
                               std::vector<float> *out, std::string *errorCode,
                               std::string *errorMessage) {
  if (!out) return false;
  if (startFrame < 0 || frameCount < 0) {
    if (errorCode) *errorCode = "AUDIO_INVALID_ARGUMENT";
    if (errorMessage) *errorMessage = "startFrame/frameCount must be >= 0";
    return false;
  }
  auto live = pa_get_live_entry(bufferId);
  if (!live) {
    if (pa_is_live_invalidated(bufferId)) {
      if (errorCode) *errorCode = "BUFFER_INVALIDATED";
      if (errorMessage) *errorMessage = "Live buffer is invalidated after transfer";
    } else {
      if (errorCode) *errorCode = "AUDIO_BUFFER_NOT_FOUND";
      if (errorMessage) *errorMessage = "Live buffer not found";
    }
    return false;
  }
  *out = live->getSamplesSlice(startFrame, frameCount);
  return true;
}

bool pa_copy_live_samples_slice(const std::string &bufferId, int startFrame, int frameCount,
                                float *dest, int maxSamples, int *outCopied,
                                std::string *errorCode, std::string *errorMessage) {
  if (outCopied) *outCopied = 0;
  if (!dest) {
    if (errorCode) *errorCode = "AUDIO_INVALID_ARGUMENT";
    if (errorMessage) *errorMessage = "dest must be non-null";
    return false;
  }
  if (startFrame < 0 || frameCount < 0 || maxSamples < 0) {
    if (errorCode) *errorCode = "AUDIO_INVALID_ARGUMENT";
    if (errorMessage) *errorMessage = "startFrame/frameCount/maxSamples must be >= 0";
    return false;
  }
  if (maxSamples == 0 || frameCount == 0) {
    return true;
  }
  auto live = pa_get_live_entry(bufferId);
  if (!live) {
    if (pa_is_live_invalidated(bufferId)) {
      if (errorCode) *errorCode = "BUFFER_INVALIDATED";
      if (errorMessage) *errorMessage = "Live buffer is invalidated after transfer";
    } else {
      if (errorCode) *errorCode = "AUDIO_BUFFER_NOT_FOUND";
      if (errorMessage) *errorMessage = "Live buffer not found";
    }
    return false;
  }
  int n = live->copySamplesSliceInto(startFrame, frameCount, dest, maxSamples);
  if (outCopied) *outCopied = n;
  return true;
}

/**
 * Resolve live under g_pa_mutex, append under entry ringMutex (no registry lock across PCM).
 * Perf keep: docs/internal/audiobuffer/performance/audiobuffer-perf-plan.md (C #11).
 */
bool pa_append_samples_to_live(const std::string &bufferId, const float *samples, size_t count,
                               int sampleRate, std::string *errorCode, std::string *errorMessage) {
  if (!samples || count == 0 || sampleRate <= 0) {
    if (errorCode) *errorCode = "AUDIO_INVALID_ARGUMENT";
    if (errorMessage) *errorMessage = "Invalid samples or sample rate";
    return false;
  }
  auto live = pa_get_live_entry(bufferId);
  if (!live) {
    if (pa_is_live_invalidated(bufferId)) {
      if (errorCode) *errorCode = "BUFFER_INVALIDATED";
      if (errorMessage) *errorMessage = "Live buffer is invalidated after transfer";
    } else {
      if (errorCode) *errorCode = "AUDIO_BUFFER_NOT_FOUND";
      if (errorMessage) *errorMessage = "Live buffer not found";
    }
    return false;
  }
  try {
    live->appendSamples(samples, count, sampleRate,
                        PaLiveAppendOrigin::ingress(PaLiveIngressSource::Append), false);
    return true;
  } catch (const std::runtime_error &e) {
    if (errorCode) *errorCode = "AUDIO_INVALID_STATE";
    if (errorMessage) *errorMessage = e.what();
    return false;
  }
}

/**
 * Int16→f32 in stack chunks; resolve live once (no full-length float temp).
 * Perf keep: docs/internal/audiobuffer/performance/audiobuffer-perf-plan.md (C #4).
 */
bool pa_append_int16_samples_to_live(const std::string &bufferId, const int16_t *samples,
                                     size_t count, int sampleRate, std::string *errorCode,
                                     std::string *errorMessage) {
  if (!samples || count == 0 || sampleRate <= 0) {
    if (errorCode) *errorCode = "AUDIO_INVALID_ARGUMENT";
    if (errorMessage) *errorMessage = "Invalid samples or sample rate";
    return false;
  }
  auto live = pa_get_live_entry(bufferId);
  if (!live) {
    if (pa_is_live_invalidated(bufferId)) {
      if (errorCode) *errorCode = "BUFFER_INVALIDATED";
      if (errorMessage) *errorMessage = "Live buffer is invalidated after transfer";
    } else {
      if (errorCode) *errorCode = "AUDIO_BUFFER_NOT_FOUND";
      if (errorMessage) *errorMessage = "Live buffer not found";
    }
    return false;
  }
  constexpr size_t kChunk = 4096;
  std::array<float, kChunk> converted{};
  size_t offset = 0;
  try {
    while (offset < count) {
      const size_t n = std::min(kChunk, count - offset);
      for (size_t i = 0; i < n; ++i) {
        converted[i] = static_cast<float>(samples[offset + i]) / 32768.0f;
      }
      live->appendSamples(converted.data(), n, sampleRate,
                          PaLiveAppendOrigin::ingress(PaLiveIngressSource::Append), false);
      offset += n;
    }
    return true;
  } catch (const std::runtime_error &e) {
    if (errorCode) *errorCode = "AUDIO_INVALID_STATE";
    if (errorMessage) *errorMessage = e.what();
    return false;
  }
}

#if defined(__APPLE__)
#include <Accelerate/Accelerate.h>

/**
 * vDSP_vflt16 + scale vs portable scalar convert.
 * Perf keep: docs/internal/audiobuffer/performance/audiobuffer-perf-plan.md (D-I1).
 */
bool pa_append_int16_samples_to_live_vdsp(const std::string &bufferId, const int16_t *samples,
                                          size_t count, int sampleRate, std::string *errorCode,
                                          std::string *errorMessage) {
  if (!samples || count == 0 || sampleRate <= 0) {
    if (errorCode) *errorCode = "AUDIO_INVALID_ARGUMENT";
    if (errorMessage) *errorMessage = "Invalid samples or sample rate";
    return false;
  }
  auto live = pa_get_live_entry(bufferId);
  if (!live) {
    if (pa_is_live_invalidated(bufferId)) {
      if (errorCode) *errorCode = "BUFFER_INVALIDATED";
      if (errorMessage) *errorMessage = "Live buffer is invalidated after transfer";
    } else {
      if (errorCode) *errorCode = "AUDIO_BUFFER_NOT_FOUND";
      if (errorMessage) *errorMessage = "Live buffer not found";
    }
    return false;
  }
  constexpr size_t kChunk = 4096;
  std::array<float, kChunk> converted{};
  const float scale = 1.0f / 32768.0f;
  size_t offset = 0;
  try {
    while (offset < count) {
      const size_t n = std::min(kChunk, count - offset);
      vDSP_vflt16(samples + offset, 1, converted.data(), 1, n);
      vDSP_vsmul(converted.data(), 1, &scale, converted.data(), 1, n);
      live->appendSamples(converted.data(), n, sampleRate,
                          PaLiveAppendOrigin::ingress(PaLiveIngressSource::Append), false);
      offset += n;
    }
    return true;
  } catch (const std::runtime_error &e) {
    if (errorCode) *errorCode = "AUDIO_INVALID_STATE";
    if (errorMessage) *errorMessage = e.what();
    return false;
  }
}
#endif

bool pa_append_offline_to_live(const std::string &liveBufferId, const std::string &offlineBufferId,
                               std::string *errorCode, std::string *errorMessage) {
  auto live = pa_get_live_entry(liveBufferId);
  if (!live) {
    if (pa_is_live_invalidated(liveBufferId)) {
      if (errorCode) *errorCode = "BUFFER_INVALIDATED";
      if (errorMessage) *errorMessage = "Live buffer is invalidated after transfer";
    } else {
      if (errorCode) *errorCode = "AUDIO_BUFFER_NOT_FOUND";
      if (errorMessage) *errorMessage = "Live buffer not found";
    }
    return false;
  }
  auto offline = pa_get_offline_entry(offlineBufferId);
  if (!offline) {
    if (errorCode) *errorCode = "AUDIO_BUFFER_NOT_FOUND";
    if (errorMessage) *errorMessage = "Offline buffer not found";
    return false;
  }
  const float *ptr = offline->floatPtr();
  const int n = offline->numSamples();
  if (n < 0) {
    if (errorCode) *errorCode = "AUDIO_INTERNAL_ERROR";
    if (errorMessage) *errorMessage = "Invalid offline sample count";
    return false;
  }
  if (n == 0) return true;
  if (!ptr) {
    if (errorCode) *errorCode = "AUDIO_INTERNAL_ERROR";
    if (errorMessage) *errorMessage = "Offline floatPtr unavailable";
    return false;
  }
  constexpr int kChunk = 8192;
  try {
    for (int offset = 0; offset < n; offset += kChunk) {
      const int count = std::min(kChunk, n - offset);
      live->appendSamples(ptr + offset, static_cast<size_t>(count), offline->sampleRate,
                          PaLiveAppendOrigin::ingress(PaLiveIngressSource::AppendOffline), false);
    }
    return true;
  } catch (const std::runtime_error &e) {
    if (errorCode) *errorCode = "AUDIO_INVALID_STATE";
    if (errorMessage) *errorMessage = e.what();
    return false;
  }
}

bool pa_clone_offline(const std::string &sourceBufferId, std::string *offlineBufferIdOut,
                      std::string *errorCode, std::string *errorMessage) {
  auto source = pa_get_offline_entry(sourceBufferId);
  if (!source) {
    if (errorCode) *errorCode = "AUDIO_BUFFER_NOT_FOUND";
    if (errorMessage) *errorMessage = "Offline buffer not found";
    return false;
  }
  const float *ptr = source->floatPtr();
  const int n = source->numSamples();
  if (n < 0 || (n > 0 && !ptr)) {
    if (errorCode) *errorCode = "AUDIO_INTERNAL_ERROR";
    if (errorMessage) *errorMessage = "Offline floatPtr unavailable";
    return false;
  }
  std::string bufferId = pa_generate_id("off");
  std::vector<float> owned;
  if (n > 0) {
    owned.assign(ptr, ptr + n);
  }
  auto entry =
      pa_create_entry_with_threshold(bufferId, source->sampleRate, source->channelCount, owned);
  if (!entry) {
    if (errorCode) *errorCode = "AUDIO_INTERNAL_ERROR";
    if (errorMessage) *errorMessage = "Failed to clone offline buffer";
    return false;
  }
  {
    std::lock_guard<std::mutex> lock(g_pa_mutex);
    g_pa_offline[bufferId] = entry;
  }
  if (offlineBufferIdOut) *offlineBufferIdOut = bufferId;
  return true;
}

bool pa_drain_cursor_into(const std::string &liveBufferId, int cursorId, float *dest,
                          int maxSamples, int *outCopied, std::string *errorCode,
                          std::string *errorMessage) {
  if (outCopied) *outCopied = 0;
  if (!dest) {
    if (errorCode) *errorCode = "AUDIO_INVALID_ARGUMENT";
    if (errorMessage) *errorMessage = "dest must be non-null";
    return false;
  }
  if (maxSamples < 0 || cursorId < 0) {
    if (errorCode) *errorCode = "AUDIO_INVALID_ARGUMENT";
    if (errorMessage) *errorMessage = "cursorId/maxSamples must be >= 0";
    return false;
  }
  if (maxSamples == 0) {
    return true;
  }
  auto live = pa_get_live_entry(liveBufferId);
  if (!live) {
    if (pa_is_live_invalidated(liveBufferId)) {
      if (errorCode) *errorCode = "BUFFER_INVALIDATED";
      if (errorMessage) *errorMessage = "Live buffer is invalidated after transfer";
    } else {
      if (errorCode) *errorCode = "AUDIO_BUFFER_NOT_FOUND";
      if (errorMessage) *errorMessage = "Live buffer not found";
    }
    return false;
  }
  try {
    int n = live->drainCursorInto(cursorId, dest, maxSamples);
    if (outCopied) *outCopied = n;
    return true;
  } catch (const std::runtime_error &e) {
    if (errorCode) *errorCode = "AUDIO_INVALID_STATE";
    if (errorMessage) *errorMessage = e.what();
    return false;
  }
}

bool pa_get_offline_metadata(const std::string &bufferId, int *sampleRate, int *numSamples,
                             std::string *errorCode, std::string *errorMessage) {
  if (!sampleRate || !numSamples) return false;
  std::shared_ptr<PaOfflineEntry> entry;
  {
    std::lock_guard<std::mutex> lock(g_pa_mutex);
    auto it = g_pa_offline.find(bufferId);
    if (it == g_pa_offline.end()) {
      if (errorCode) *errorCode = "AUDIO_BUFFER_NOT_FOUND";
      if (errorMessage) *errorMessage = "Offline buffer not found";
      return false;
    }
    entry = it->second;
  }
  *sampleRate = entry->sampleRate;
  *numSamples = entry->numSamples();
  return true;
}

bool pa_adopt_offline_samples_if_empty(const std::string &bufferId, std::vector<float> &&samples,
                                       std::string *errorCode, std::string *errorMessage) {
  int targetSampleRate = 0;
  int targetChannelCount = 0;
  {
    std::lock_guard<std::mutex> lock(g_pa_mutex);
    auto it = g_pa_offline.find(bufferId);
    if (it == g_pa_offline.end()) {
      if (errorCode) *errorCode = "AUDIO_BUFFER_NOT_FOUND";
      if (errorMessage) *errorMessage = "Offline buffer not found";
      return false;
    }
    if (it->second->numSamples() > 0) {
      if (errorCode) *errorCode = "AUDIO_INVALID_STATE";
      if (errorMessage) *errorMessage = "Offline buffer is not empty";
      return false;
    }
    targetSampleRate = it->second->sampleRate;
    targetChannelCount = it->second->channelCount;
  }
  auto replacement =
      pa_create_entry_with_threshold(bufferId, targetSampleRate, targetChannelCount, samples);
  if (!replacement) {
    if (errorCode) *errorCode = "AUDIO_INTERNAL_ERROR";
    if (errorMessage) *errorMessage = "Failed to adopt samples into offline buffer";
    return false;
  }
  {
    std::lock_guard<std::mutex> lock(g_pa_mutex);
    auto it = g_pa_offline.find(bufferId);
    if (it == g_pa_offline.end()) {
      if (errorCode) *errorCode = "AUDIO_BUFFER_NOT_FOUND";
      if (errorMessage) *errorMessage = "Offline buffer not found";
      return false;
    }
    if (it->second->numSamples() > 0) {
      if (errorCode) *errorCode = "AUDIO_INVALID_STATE";
      if (errorMessage) *errorMessage = "Offline buffer is not empty";
      return false;
    }
    it->second = replacement;
  }
  return true;
}

bool pa_create_empty_offline(int sampleRate, int channelCount, std::string *bufferIdOut,
                             std::string *errorCode, std::string *errorMessage) {
  if (sampleRate <= 0 || channelCount != 1) {
    if (errorCode) *errorCode = "AUDIO_INVALID_ARGUMENT";
    if (errorMessage) *errorMessage = "Invalid sampleRate/channelCount";
    return false;
  }
  std::string bufferId = pa_generate_id("off");
  auto entry = std::make_shared<PaOfflineEntry>();
  entry->bufferId = bufferId;
  entry->sampleRate = sampleRate;
  entry->channelCount = channelCount;
  {
    std::lock_guard<std::mutex> lock(g_pa_mutex);
    g_pa_offline[bufferId] = entry;
  }
  if (bufferIdOut) *bufferIdOut = bufferId;
  return true;
}

bool pa_create_live(int sampleRate, int channelCount, double windowSec,
                    const std::string &spoolPathOrEmpty, bool emitAppendEvents,
                    int appendEventMinIntervalMs, std::string *bufferIdOut,
                    std::string *errorCode, std::string *errorMessage) {
  if (sampleRate <= 0 || channelCount != 1 || windowSec <= 0) {
    if (errorCode) *errorCode = "AUDIO_INVALID_ARGUMENT";
    if (errorMessage) *errorMessage = "Invalid live buffer args";
    return false;
  }
  std::string bufferId = pa_generate_id("live");
  auto entry = std::make_shared<PaLiveEntry>(bufferId, sampleRate, channelCount, windowSec,
                                            spoolPathOrEmpty, emitAppendEvents,
                                            appendEventMinIntervalMs, nullptr);
  {
    std::lock_guard<std::mutex> lock(g_pa_mutex);
    g_pa_live[bufferId] = entry;
  }
  if (bufferIdOut) *bufferIdOut = bufferId;
  return true;
}

bool pa_finalize_live(const std::string &liveBufferId, std::string *errorCode,
                      std::string *errorMessage) {
  auto live = pa_get_live_entry(liveBufferId);
  if (!live) {
    if (errorCode) *errorCode = "AUDIO_BUFFER_NOT_FOUND";
    if (errorMessage) *errorMessage = "Live buffer not found";
    return false;
  }
  live->finalize_();
  return true;
}

bool pa_release_buffer(const std::string &bufferId) {
  std::shared_ptr<PaOfflineEntry> off;
  std::shared_ptr<PaLiveEntry> live;
  {
    std::lock_guard<std::mutex> lock(g_pa_mutex);
    auto oit = g_pa_offline.find(bufferId);
    if (oit != g_pa_offline.end()) {
      off = oit->second;
      g_pa_offline.erase(oit);
    }
    auto lit = g_pa_live.find(bufferId);
    if (lit != g_pa_live.end()) {
      live = lit->second;
      g_pa_live.erase(lit);
    }
  }
  // Views hold another shared_ptr. Only tear storage down when this is the last owner
  // so an in-flight pa_acquire view stays valid after the id leaves the registry.
  if (off && off.use_count() == 1) off->release();
  if (live && live.use_count() == 1) live->release();
  return off || live;
}

std::vector<float> pa_read_f32_wav_spool_samples(const std::string &spoolPath) {
  std::ifstream wavFile(spoolPath, std::ios::binary);
  if (!wavFile) return {};
  wavFile.seekg(0, std::ios::end);
  std::streamoff fileSize = wavFile.tellg();
  if (fileSize <= 44) return {};
  wavFile.seekg(44);
  if (!wavFile) return {};
  size_t payloadBytes = (size_t)(fileSize - 44);
  if (payloadBytes % sizeof(float) != 0) return {};
  size_t sampleCount = payloadBytes / sizeof(float);
  if (sampleCount == 0) return {};
  std::vector<float> samples(sampleCount);
  wavFile.read(reinterpret_cast<char *>(samples.data()), (std::streamsize)payloadBytes);
  if (!wavFile && wavFile.gcount() != (std::streamsize)payloadBytes) return {};
  return samples;
}

bool pa_populate_offline_from_source_if_empty(const std::string &targetBufferId,
                                              const std::string &sourceBufferId,
                                              std::string *errorCode, std::string *errorMessage) {
  if (targetBufferId == sourceBufferId) return true;
  std::lock_guard<std::mutex> lock(g_pa_mutex);
  auto targetIt = g_pa_offline.find(targetBufferId);
  if (targetIt == g_pa_offline.end() || !targetIt->second) {
    if (errorCode) *errorCode = "AUDIO_BUFFER_NOT_FOUND";
    if (errorMessage) *errorMessage = "Offline target buffer not found";
    return false;
  }
  auto sourceIt = g_pa_offline.find(sourceBufferId);
  if (sourceIt == g_pa_offline.end() || !sourceIt->second) {
    if (errorCode) *errorCode = "AUDIO_BUFFER_NOT_FOUND";
    if (errorMessage) *errorMessage = "Offline source buffer not found";
    return false;
  }
  auto target = targetIt->second;
  auto source = sourceIt->second;
  if (target->numSamples() > 0) {
    if (errorCode) *errorCode = "AUDIO_INVALID_STATE";
    if (errorMessage) *errorMessage = "Offline target buffer is not empty";
    return false;
  }
  if (target->sampleRate != source->sampleRate || target->channelCount != source->channelCount) {
    if (errorCode) *errorCode = "AUDIO_INVALID_ARGUMENT";
    if (errorMessage) *errorMessage = "Offline target/source format mismatch";
    return false;
  }
  auto replacement = std::make_shared<PaOfflineEntry>();
  replacement->bufferId = targetBufferId;
  replacement->sampleRate = source->sampleRate;
  replacement->channelCount = source->channelCount;
  if (source->isMmapBacked()) {
    replacement->mmapRegion = std::move(source->mmapRegion);
  } else {
    replacement->samples = std::move(source->samples);
  }
  g_pa_offline[targetBufferId] = replacement;
  g_pa_offline.erase(sourceBufferId);
  return true;
}

long pa_file_origin_threshold_bytes() {
  if (!g_pa_threshold_configured) {
    pa_configure_threshold(6ULL * 1024ULL * 1024ULL * 1024ULL);
  }
  return gPaThresholdSnapshot.fileOriginThresholdBytes;
}

bool pa_transfer_offline_from_live(const std::string &liveBufferId, bool fullIfSpooled,
                                   std::string *offlineBufferIdOut, std::string *errorCode,
                                   std::string *errorMessage) {
  auto live = pa_get_live_entry(liveBufferId);
  if (!live) {
    if (errorCode) *errorCode = "AUDIO_BUFFER_NOT_FOUND";
    if (errorMessage) *errorMessage = "Live buffer not found";
    return false;
  }
  if (live->state != PaLiveEntry::FINISHED) {
    if (errorCode) *errorCode = "TRANSFER_INVALID_STATE";
    if (errorMessage) *errorMessage = "Live buffer must be finalized";
    return false;
  }
  if (live->activeCursorCount() > 0) {
    if (errorCode) *errorCode = "TRANSFER_CURSORS_ACTIVE";
    if (errorMessage) *errorMessage = "Release cursors before transfer";
    return false;
  }

  std::string offlineId = pa_generate_id("off");
  std::shared_ptr<PaOfflineEntry> entry;
  if (fullIfSpooled && live->hasActiveSpool && !live->spoolPath.empty()) {
    entry = pa_create_offline_from_transferred_wav_spool(offlineId, live->spoolPath,
                                                         live->sampleRate, live->channelCount);
    if (!entry) {
      if (errorCode) *errorCode = "TRANSFER_SPOOL_UNAVAILABLE";
      if (errorMessage) *errorMessage = "Failed to adopt live spool";
      return false;
    }
    live->detachSpoolForTransfer();
  } else {
    auto samples = live->snapshotRing();
    entry = pa_create_entry_with_threshold(offlineId, live->sampleRate, live->channelCount, samples);
  }
  if (!entry) {
    if (errorCode) *errorCode = "AUDIO_INTERNAL_ERROR";
    if (errorMessage) *errorMessage = "Failed to create offline from live";
    return false;
  }

  {
    std::lock_guard<std::mutex> lock(g_pa_mutex);
    g_pa_offline[offlineId] = entry;
    g_pa_live.erase(liveBufferId);
    g_pa_invalidated_live_ids.insert(liveBufferId);
  }
  live->release();
  if (offlineBufferIdOut) *offlineBufferIdOut = offlineId;
  return true;
}
