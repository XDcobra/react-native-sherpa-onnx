#pragma once

/**
 * Shared pipeline AudioBuffer registry (offline + live).
 * Stable C API names (`pa_*`) kept for iOS workers / JSI callers.
 */

#include "PaLiveEntry.h"
#include "PaOfflineEntry.h"

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

extern std::unordered_map<std::string, std::shared_ptr<PaOfflineEntry>> g_pa_offline;
extern std::unordered_map<std::string, std::shared_ptr<PaLiveEntry>> g_pa_live;
extern std::unordered_set<std::string> g_pa_invalidated_live_ids;
extern std::mutex g_pa_mutex;

/** Configure temp/cache directory for mmap .f32 and live spool paths. */
void pa_configure_cache_dir(const std::string &cacheDir);

/** Configure mmap thresholds from device total RAM (bytes). Call once at init. */
void pa_configure_threshold(uint64_t totalRamBytes);

std::string pa_generate_id(const char *prefix);
std::string pa_temp_dir();

std::shared_ptr<PaLiveEntry> pa_get_live_entry(const std::string &bufferId);
bool pa_is_live_invalidated(const std::string &bufferId);

std::shared_ptr<PaOfflineEntry> pa_get_offline_entry(const std::string &bufferId);

struct PaOfflineSampleView {
  std::shared_ptr<PaOfflineEntry> entry; // keeps storage alive
  const float *data = nullptr;
  size_t count = 0;
  int sampleRate = 0;
};

/** Acquire a contiguous view into offline PCM. startSample/endSampleExclusive:
 *  use startSample<0 and endSampleExclusive<0 for the full buffer.
 *  Empty buffer → true with count==0 (data may be null). Missing buffer → false.
 *  Pointer valid only while `out->entry` is held. Releasing the buffer id drops
 *  the registry entry; storage stays alive until the last view is destroyed. */
bool pa_acquire_offline_sample_view(const std::string &bufferId, int startSample,
                                    int endSampleExclusive, PaOfflineSampleView *out,
                                    std::string *errorCode, std::string *errorMessage);

bool pa_read_offline_samples(const std::string &bufferId, std::vector<float> *samples,
                             int *sampleRate);

bool pa_create_offline_from_samples(const float *samples, size_t count, int sampleRate,
                                    int channelCount, std::string *json, std::string *errorCode,
                                    std::string *errorMessage);

bool pa_get_offline_samples_slice(const std::string &bufferId, int startFrame, int frameCount,
                                  std::vector<float> *out, std::string *errorCode,
                                  std::string *errorMessage);

/** Copy up to maxSamples from offline buffer into caller-owned dest (mmap or RAM). */
bool pa_copy_offline_samples(const std::string &bufferId, int startSample, float *dest,
                             int maxSamples, int *outCopied, std::string *errorCode,
                             std::string *errorMessage);

bool pa_get_live_samples_slice(const std::string &bufferId, int startFrame, int frameCount,
                               std::vector<float> *out, std::string *errorCode,
                               std::string *errorMessage);

/** Copy live ring slice into caller-owned dest (non-advancing; mmap/RAM offline twin is pa_copy_offline). */
bool pa_copy_live_samples_slice(const std::string &bufferId, int startFrame, int frameCount,
                                float *dest, int maxSamples, int *outCopied,
                                std::string *errorCode, std::string *errorMessage);

bool pa_append_samples_to_live(const std::string &bufferId, const float *samples, size_t count,
                               int sampleRate, std::string *errorCode, std::string *errorMessage);

/** Convert Int16 PCM (÷32768) then append to live ring — same semantics as float append. */
bool pa_append_int16_samples_to_live(const std::string &bufferId, const int16_t *samples,
                                     size_t count, int sampleRate, std::string *errorCode,
                                     std::string *errorMessage);

/** Drain live cursor into caller-owned dest; advances cursor like drainCursor. */
bool pa_drain_cursor_into(const std::string &liveBufferId, int cursorId, float *dest,
                          int maxSamples, int *outCopied, std::string *errorCode,
                          std::string *errorMessage);

bool pa_get_offline_metadata(const std::string &bufferId, int *sampleRate, int *numSamples,
                             std::string *errorCode, std::string *errorMessage);

bool pa_adopt_offline_samples_if_empty(const std::string &bufferId, std::vector<float> &&samples,
                                       std::string *errorCode, std::string *errorMessage);

void pa_sweepOrphanedTempFiles(int maxAgeSec = 3600);
void pa_sweepOrphanedOrchestrationFiles(int maxAgeSec = 3600);
void pa_cleanupOrphanedOrchestrationFiles(int maxAgeSec = 3600);

void pa_upgradeToMmapIfNeeded(const std::string &bufferId);

void pa_register_decode_cancel(const std::string &opId, std::shared_ptr<std::atomic<bool>> flag);
void pa_unregister_decode_cancel(const std::string &opId);
std::shared_ptr<std::atomic<bool>> pa_get_decode_cancel(const std::string &opId);

bool pa_create_offline_from_f32_file(const std::string &f32Path, int sampleRate, int channelCount,
                                     std::string *bufferIdOut, std::string *errorCode,
                                     std::string *errorMessage);

std::shared_ptr<PaOfflineEntry> pa_create_entry_with_threshold(const std::string &bufferId,
                                                               int sampleRate, int channelCount,
                                                               std::vector<float> &samples);

std::shared_ptr<PaOfflineEntry> pa_create_offline_from_f32_wav_spool(const std::string &bufferId,
                                                                    const std::string &spoolPath,
                                                                    int sampleRate,
                                                                    int channelCount);

std::shared_ptr<PaOfflineEntry> pa_create_offline_from_transferred_wav_spool(
    const std::string &bufferId, const std::string &spoolPath, int sampleRate, int channelCount);

bool pa_create_empty_offline(int sampleRate, int channelCount, std::string *bufferIdOut,
                             std::string *errorCode, std::string *errorMessage);

bool pa_create_live(int sampleRate, int channelCount, double windowSec,
                    const std::string &spoolPathOrEmpty, bool emitAppendEvents,
                    int appendEventMinIntervalMs, std::string *bufferIdOut,
                    std::string *errorCode, std::string *errorMessage);

bool pa_finalize_live(const std::string &liveBufferId, std::string *errorCode,
                      std::string *errorMessage);

bool pa_release_buffer(const std::string &bufferId);

bool pa_transfer_offline_from_live(const std::string &liveBufferId, bool fullIfSpooled,
                                   std::string *offlineBufferIdOut, std::string *errorCode,
                                   std::string *errorMessage);

std::vector<float> pa_read_f32_wav_spool_samples(const std::string &spoolPath);

bool pa_populate_offline_from_source_if_empty(const std::string &targetBufferId,
                                              const std::string &sourceBufferId,
                                              std::string *errorCode, std::string *errorMessage);

/** Bytes threshold for FILE_ORIGIN mmap decisions (after pa_configure_threshold). */
long pa_file_origin_threshold_bytes();
