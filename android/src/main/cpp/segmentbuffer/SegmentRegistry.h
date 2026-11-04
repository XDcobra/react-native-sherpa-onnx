#pragma once

/**
 * Shared pipeline SegmentBuffer registry (offline + live + SEG2).
 * Stable `seg_*` API for iOS workers / Android JNI.
 */

#include "SegLiveEntry.h"
#include "SegTypes.h"

#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

extern std::unordered_map<std::string, std::shared_ptr<SegOfflineEntry>> g_seg_offline;
extern std::unordered_map<std::string, std::shared_ptr<SegLiveEntry>> g_seg_live;
extern std::mutex g_seg_mutex;

void seg_configure_cache_dir(const std::string &cacheDir);
std::string seg_temp_dir();
std::string seg_generate_id(const char *prefix);
std::string seg_uuid();

bool seg_is_valid_kind(const std::string &kind);

std::shared_ptr<SegLiveEntry> seg_get_live_entry(const std::string &bufferId);
std::shared_ptr<SegOfflineEntry> seg_get_offline_entry(const std::string &bufferId);

int seg_live_add_commit_listener(
    const std::string &liveBufferId,
    std::function<void(const std::string &, int, const SegRecord &)> listener, std::string *error);
void seg_live_remove_commit_listener(const std::string &liveBufferId, int token);
int seg_live_create_cursor(const std::string &liveBufferId, std::string *error);
std::vector<SegRecord> seg_live_drain_segments(const std::string &liveBufferId, int cursorId,
                                               int maxCount, int *startIndex, std::string *error);
void seg_live_release_cursor(const std::string &liveBufferId, int cursorId);

bool seg_live_append_segment(const std::string &liveBufferId, const std::string &kind,
                             const std::string &sourceAudioBufferId, int startSample, int endSample,
                             int sampleRate, int durationMs, bool hasConfidence, double confidence,
                             const std::string &payloadJson, std::string *segmentId,
                             int *segmentIndex, std::string *error, bool emitAppended = true);

/** Emit pipelineLiveSegmentAppended for a segment already stored on the live buffer. */
void seg_live_emit_appended(const std::string &liveBufferId, const std::string &segmentId,
                            int segmentIndex);

bool seg_create_empty_offline(const std::string &sourceAudioBufferIdOrEmpty, std::string *bufferIdOut,
                              std::string *error = nullptr);
bool seg_create_live(const std::string &sourceAudioBufferIdOrEmpty, int maxSegments,
                     const std::string &spoolMode, const std::string &spoolPathOrEmpty,
                     bool spoolTemporary, int64_t spoolThresholdBytes, bool emitSegmentAppended,
                     int64_t segmentEventMinIntervalMs, std::string *bufferIdOut,
                     std::string *error = nullptr);
bool seg_finalize_live(const std::string &liveBufferId, std::string *error = nullptr);
bool seg_release_buffer(const std::string &bufferId);
bool seg_create_offline_from_live(const std::string &liveBufferId, const std::string &mode,
                                  std::string *bufferIdOut, std::string *error = nullptr);
bool seg_populate_offline_from_live_if_empty(const std::string &offlineBufferId,
                                             const std::string &liveBufferId,
                                             const std::string &mode, std::string *error = nullptr);

/** Offline SoT: count / bounded slice / one-shot populate (engine finalize). */
int seg_offline_segment_count(const std::string &offlineBufferId);
std::vector<SegRecord> seg_offline_get_segments(const std::string &offlineBufferId, int start,
                                                int maxCount);
std::vector<SegRecord> seg_live_get_window_segments(const std::string &liveBufferId, int start,
                                                    int maxCount);
bool seg_offline_populate(const std::string &offlineBufferId,
                          const std::vector<SegRecord> &records, std::string *error = nullptr);

/** TurboModule segment getter page size (align TS / Android / iOS). */
constexpr int SEG_TM_DEFAULT_PAGE_COUNT = 4096;
constexpr int SEG_TM_MAX_PAGE_COUNT = 4096;
/** Clamp requested page size: <=0 → 0; else min(requested, SEG_TM_MAX_PAGE_COUNT). */
int seg_clamp_tm_page_count(int requested);

void seg_release_all_entries();

/** Optional: bridge installs callback for pipelineLiveSegmentAppended. */
using SegAppendedEmitFn = void (*)(const std::string &bufferId, const SegRecord &rec,
                                   int segmentIndex, int totalSegments);
void seg_set_appended_emit_fn(SegAppendedEmitFn fn);

// Segmentation engine lifecycle hooks (strong on iOS SegEngine; weak stubs in SegmentRegistry.cpp).
void seg_engine_on_text_write(const std::string &liveBufferId);
void seg_engine_on_audio_append(const std::string &liveBufferId, const float *samples, size_t count,
                                int sampleRate, int64_t totalSamplesWritten);
void seg_engine_on_buffer_finalized(const std::string &bufferId);
void seg_engine_on_buffer_released(const std::string &bufferId);
bool seg_engine_detach(const std::string &engineId, bool flushFinal, std::string *error);
bool seg_engine_flush(const std::string &engineId, std::string *error);
bool seg_engine_peek_annotation(const std::string &segmentId, std::string *reason,
                                std::string *source, int64_t *createdAtMs, int *segmentIndex);
