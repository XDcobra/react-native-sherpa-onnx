#pragma once

#ifdef __cplusplus
#ifdef __OBJC__
#import <Foundation/Foundation.h>
#endif
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

struct SegRecord {
  std::string id;
  std::string kind;
  std::string sourceAudioBufferId;
  int startSample = 0;
  int endSample = 0;
  int sampleRate = 0;
  int durationMs = 0;
  bool hasConfidence = false;
  double confidence = 0.0;
  std::string payloadJson;
};

struct SegOfflineEntry {
  std::string bufferId;
  std::vector<SegRecord> segments;
  std::string sourceAudioBufferId;
};

struct SegLiveEntry;

extern std::unordered_map<std::string, std::shared_ptr<SegOfflineEntry>> g_seg_offline;
extern std::unordered_map<std::string, std::shared_ptr<SegLiveEntry>> g_seg_live;
extern std::mutex g_seg_mutex;

std::shared_ptr<SegLiveEntry> seg_get_live_entry(const std::string &bufferId);
int seg_live_add_commit_listener(
  const std::string &liveBufferId,
  std::function<void(const std::string &, int, const SegRecord &)> listener,
  std::string *error
);
void seg_live_remove_commit_listener(const std::string &liveBufferId, int token);
int seg_live_create_cursor(const std::string &liveBufferId, std::string *error);
std::vector<SegRecord> seg_live_drain_segments(
  const std::string &liveBufferId,
  int cursorId,
  int maxCount,
  int *startIndex,
  std::string *error
);
void seg_live_release_cursor(const std::string &liveBufferId, int cursorId);
bool seg_live_append_segment(
  const std::string &liveBufferId,
  const std::string &kind,
  const std::string &sourceAudioBufferId,
  int startSample,
  int endSample,
  int sampleRate,
  int durationMs,
  bool hasConfidence,
  double confidence,
  const std::string &payloadJson,
  std::string *segmentId,
  int *segmentIndex,
  std::string *error
);

void seg_release_all_entries();

// Segmentation engine lifecycle hooks.
void seg_engine_on_text_write(const std::string &liveBufferId);
void seg_engine_on_audio_append(
  const std::string &liveBufferId,
  const float *samples,
  size_t count,
  int sampleRate,
  int64_t totalSamplesWritten
);
void seg_engine_on_buffer_finalized(const std::string &bufferId);
void seg_engine_on_buffer_released(const std::string &bufferId);
bool seg_engine_detach(const std::string &engineId, bool flushFinal, std::string *error);

// Segment annotation metadata (reason/source/timestamps) emitted by native engines.
bool seg_engine_peek_annotation(
  const std::string &segmentId,
  std::string *reason,
  std::string *source,
  int64_t *createdAtMs,
  int *segmentIndex
);
#endif
