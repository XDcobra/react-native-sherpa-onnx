#include "SegmentRegistry.h"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <random>
#include <sstream>

namespace {

std::string g_seg_cache_dir;
SegAppendedEmitFn g_seg_appended_emit = nullptr;

std::string makeUuidLike() {
  static thread_local std::mt19937_64 rng{std::random_device{}()};
  std::uniform_int_distribution<uint64_t> dist;
  uint64_t a = dist(rng);
  uint64_t b = dist(rng);
  char buf[40];
  std::snprintf(buf, sizeof(buf), "%016llx%016llx", (unsigned long long)a, (unsigned long long)b);
  return std::string(buf);
}

SegLiveEntry::SpoolingMode parseSpoolMode(const std::string &mode) {
  if (mode == "off") return SegLiveEntry::SPOOL_OFF;
  if (mode == "auto") return SegLiveEntry::SPOOL_AUTO;
  return SegLiveEntry::SPOOL_ON;
}

void notifyAppended(const std::shared_ptr<SegLiveEntry> &entry, const SegRecord &seg, int idx) {
  if (!entry->emitSegmentAppended) return;
  const int64_t now = std::chrono::duration_cast<std::chrono::milliseconds>(
                          std::chrono::system_clock::now().time_since_epoch())
                          .count();
  if (entry->segmentEventMinIntervalMs > 0 &&
      now - entry->lastSegmentEmitWallMs < entry->segmentEventMinIntervalMs) {
    return;
  }
  entry->lastSegmentEmitWallMs = now;
  const int total = static_cast<int>(entry->segments.size());
  if (entry->segmentAppendedEmitter) {
    entry->segmentAppendedEmitter(entry->bufferId, seg, idx, total);
  }
  if (g_seg_appended_emit) {
    g_seg_appended_emit(entry->bufferId, seg, idx, total);
  }
}

}  // namespace

std::unordered_map<std::string, std::shared_ptr<SegOfflineEntry>> g_seg_offline;
std::unordered_map<std::string, std::shared_ptr<SegLiveEntry>> g_seg_live;
std::mutex g_seg_mutex;

#if defined(__GNUC__) || defined(__clang__)
#define SEG_WEAK_ATTR __attribute__((weak))
#else
#define SEG_WEAK_ATTR
#endif

SEG_WEAK_ATTR void seg_engine_on_text_write(const std::string & /*liveBufferId*/) {}
SEG_WEAK_ATTR void seg_engine_on_audio_append(const std::string & /*liveBufferId*/,
                                              const float * /*samples*/, size_t /*count*/,
                                              int /*sampleRate*/,
                                              int64_t /*totalSamplesWritten*/) {}
SEG_WEAK_ATTR void seg_engine_on_buffer_finalized(const std::string & /*bufferId*/) {}
SEG_WEAK_ATTR void seg_engine_on_buffer_released(const std::string & /*bufferId*/) {}
SEG_WEAK_ATTR bool seg_engine_detach(const std::string & /*engineId*/, bool /*flushFinal*/,
                                     std::string * /*error*/) {
  return false;
}
SEG_WEAK_ATTR bool seg_engine_flush(const std::string & /*engineId*/, std::string * /*error*/) {
  return false;
}
SEG_WEAK_ATTR bool seg_engine_peek_annotation(const std::string & /*segmentId*/,
                                              std::string * /*reason*/, std::string * /*source*/,
                                              int64_t * /*createdAtMs*/, int * /*segmentIndex*/) {
  return false;
}

void seg_set_appended_emit_fn(SegAppendedEmitFn fn) { g_seg_appended_emit = fn; }

void seg_configure_cache_dir(const std::string &cacheDir) { g_seg_cache_dir = cacheDir; }

std::string seg_temp_dir() {
  if (!g_seg_cache_dir.empty()) return g_seg_cache_dir;
  const char *tmp = std::getenv("TMPDIR");
  if (tmp && *tmp) return std::string(tmp);
  return "/tmp";
}

std::string seg_uuid() { return makeUuidLike(); }

std::string seg_generate_id(const char *prefix) {
  return std::string(prefix) + "_" + makeUuidLike();
}

bool seg_is_valid_kind(const std::string &kind) {
  return kind == "speech" || kind == "alignment" || kind == "diarization";
}

std::shared_ptr<SegLiveEntry> seg_get_live_entry(const std::string &bufferId) {
  std::lock_guard<std::mutex> lock(g_seg_mutex);
  auto it = g_seg_live.find(bufferId);
  if (it == g_seg_live.end()) return nullptr;
  return it->second;
}

std::shared_ptr<SegOfflineEntry> seg_get_offline_entry(const std::string &bufferId) {
  std::lock_guard<std::mutex> lock(g_seg_mutex);
  auto it = g_seg_offline.find(bufferId);
  if (it == g_seg_offline.end()) return nullptr;
  return it->second;
}

int seg_live_add_commit_listener(
    const std::string &liveBufferId,
    std::function<void(const std::string &, int, const SegRecord &)> listener, std::string *error) {
  auto entry = seg_get_live_entry(liveBufferId);
  if (!entry) {
    if (error) *error = "SEGMENT_BUFFER_NOT_FOUND: Live segment buffer not found: " + liveBufferId;
    return -1;
  }
  try {
    return entry->addCommitListener(std::move(listener));
  } catch (const std::exception &e) {
    if (error) *error = e.what();
    return -1;
  }
}

void seg_live_remove_commit_listener(const std::string &liveBufferId, int token) {
  auto entry = seg_get_live_entry(liveBufferId);
  if (!entry) return;
  entry->removeCommitListener(token);
}

int seg_live_create_cursor(const std::string &liveBufferId, std::string *error) {
  auto entry = seg_get_live_entry(liveBufferId);
  if (!entry) {
    if (error) *error = "SEGMENT_BUFFER_NOT_FOUND: Live segment buffer not found: " + liveBufferId;
    return -1;
  }
  try {
    return entry->createSegmentCursor();
  } catch (const std::exception &e) {
    if (error) *error = e.what();
    return -1;
  }
}

std::vector<SegRecord> seg_live_drain_segments(const std::string &liveBufferId, int cursorId,
                                               int maxCount, int *startIndex, std::string *error) {
  auto entry = seg_get_live_entry(liveBufferId);
  if (!entry) {
    if (error) *error = "SEGMENT_BUFFER_NOT_FOUND: Live segment buffer not found: " + liveBufferId;
    if (startIndex) *startIndex = -1;
    return {};
  }
  try {
    return entry->drainSegments(cursorId, maxCount, startIndex);
  } catch (const std::exception &e) {
    if (error) *error = e.what();
    if (startIndex) *startIndex = -1;
    return {};
  }
}

void seg_live_release_cursor(const std::string &liveBufferId, int cursorId) {
  auto entry = seg_get_live_entry(liveBufferId);
  if (!entry) return;
  entry->releaseSegmentCursor(cursorId);
}

bool seg_live_append_segment(const std::string &liveBufferId, const std::string &kind,
                             const std::string &sourceAudioBufferId, int startSample, int endSample,
                             int sampleRate, int durationMs, bool hasConfidence, double confidence,
                             const std::string &payloadJson, std::string *segmentId,
                             int *segmentIndex, std::string *error) {
  auto entry = seg_get_live_entry(liveBufferId);
  if (!entry) {
    if (error) *error = "SEGMENT_BUFFER_NOT_FOUND: Live segment buffer not found: " + liveBufferId;
    return false;
  }
  try {
    SegRecord seg;
    seg.id = "seg_" + seg_uuid();
    seg.kind = kind.empty() ? "speech" : kind;
    if (!seg_is_valid_kind(seg.kind)) {
      if (error)
        *error =
            "SEGMENT_INVALID_ARGUMENT: kind must be one of speech, alignment, or diarization";
      return false;
    }
    if (sampleRate <= 0) {
      if (error) *error = "SEGMENT_INVALID_ARGUMENT: sampleRate must be > 0";
      return false;
    }
    if (endSample < startSample) {
      if (error) *error = "SEGMENT_INVALID_ARGUMENT: endSample must be >= startSample";
      return false;
    }
    seg.sourceAudioBufferId =
        sourceAudioBufferId.empty() ? entry->sourceAudioBufferId : sourceAudioBufferId;
    seg.startSample = startSample;
    seg.endSample = endSample;
    seg.sampleRate = sampleRate;
    seg.durationMs = durationMs > 0
                         ? durationMs
                         : static_cast<int>(((seg.endSample - seg.startSample) * 1000.0) /
                                            std::max(1, seg.sampleRate));
    seg.hasConfidence = hasConfidence;
    if (hasConfidence) seg.confidence = confidence;
    seg.payloadJson = payloadJson;

    int idx = 0;
    std::string checkpointSnapshot;
    {
      std::lock_guard<std::mutex> lock(entry->lock);
      if (entry->state == SegLiveEntry::FINISHED) {
        if (error) *error = "SEGMENT_ALREADY_FINALIZED: Live segment buffer is finalized";
        return false;
      }
      idx = static_cast<int>(entry->evictedCount + static_cast<int64_t>(entry->segments.size()));
      entry->segments.push_back(seg);
      if (static_cast<int>(entry->segments.size()) > entry->maxSegments) {
        entry->segments.erase(entry->segments.begin());
        entry->evictedCount++;
      }
      entry->totalSegmentsWritten++;
      checkpointSnapshot = entry->snapshotForSpoolLocked();
    }
    entry->maybeAppendSegmentToSpool(seg, true, checkpointSnapshot);
    notifyAppended(entry, seg, idx);
    entry->notifyCommitListeners(seg.id, idx, seg);

    if (segmentId) *segmentId = seg.id;
    if (segmentIndex) *segmentIndex = idx;
    return true;
  } catch (const std::exception &e) {
    if (error) *error = e.what();
    return false;
  }
}

bool seg_create_empty_offline(const std::string &sourceAudioBufferIdOrEmpty, std::string *bufferIdOut,
                              std::string *error) {
  auto entry = std::make_shared<SegOfflineEntry>();
  entry->bufferId = seg_generate_id("seg_off");
  entry->sourceAudioBufferId = sourceAudioBufferIdOrEmpty;
  entry->populated = false;
  {
    std::lock_guard<std::mutex> lock(g_seg_mutex);
    g_seg_offline[entry->bufferId] = entry;
  }
  if (bufferIdOut) *bufferIdOut = entry->bufferId;
  return true;
}

bool seg_create_live(const std::string &sourceAudioBufferIdOrEmpty, int maxSegments,
                     const std::string &spoolMode, const std::string &spoolPathOrEmpty,
                     bool spoolTemporary, int64_t spoolThresholdBytes, bool emitSegmentAppended,
                     int64_t segmentEventMinIntervalMs, std::string *bufferIdOut,
                     std::string *error) {
  try {
    auto entry = std::make_shared<SegLiveEntry>();
    entry->bufferId = seg_generate_id("seg_live");
    entry->sourceAudioBufferId = sourceAudioBufferIdOrEmpty;
    entry->maxSegments = std::max(1, maxSegments);
    entry->spoolingMode = parseSpoolMode(spoolMode);
    entry->spoolTemporary = spoolTemporary;
    entry->spoolThresholdBytes = spoolThresholdBytes;
    entry->emitSegmentAppended = emitSegmentAppended;
    entry->segmentEventMinIntervalMs = segmentEventMinIntervalMs;
    if (entry->spoolingMode != SegLiveEntry::SPOOL_OFF) {
      entry->spoolPath = spoolPathOrEmpty.empty()
                             ? (seg_temp_dir() + "/seg_spool_" + makeUuidLike())
                             : spoolPathOrEmpty;
    }
    entry->activateSpoolIfNeeded();
    {
      std::lock_guard<std::mutex> lock(g_seg_mutex);
      g_seg_live[entry->bufferId] = entry;
    }
    if (bufferIdOut) *bufferIdOut = entry->bufferId;
    return true;
  } catch (const std::exception &e) {
    if (error) *error = e.what();
    return false;
  }
}

bool seg_finalize_live(const std::string &liveBufferId, std::string *error) {
  auto entry = seg_get_live_entry(liveBufferId);
  if (!entry) {
    if (error) *error = "SEGMENT_BUFFER_NOT_FOUND: Live segment buffer not found: " + liveBufferId;
    return false;
  }
  try {
    entry->finalize_();
    seg_engine_on_buffer_finalized(liveBufferId);
    return true;
  } catch (const std::exception &e) {
    if (error) *error = e.what();
    return false;
  }
}

bool seg_release_buffer(const std::string &bufferId) {
  std::shared_ptr<SegLiveEntry> live;
  {
    std::lock_guard<std::mutex> lock(g_seg_mutex);
    auto lit = g_seg_live.find(bufferId);
    if (lit != g_seg_live.end()) {
      live = lit->second;
      g_seg_live.erase(lit);
    }
    g_seg_offline.erase(bufferId);
  }
  if (live) {
    try {
      live->release();
    } catch (...) {
    }
    seg_engine_on_buffer_released(bufferId);
    return true;
  }
  return true;
}

bool seg_create_offline_from_live(const std::string &liveBufferId, const std::string &mode,
                                  std::string *bufferIdOut, std::string *error) {
  auto live = seg_get_live_entry(liveBufferId);
  if (!live) {
    if (error) *error = "SEGMENT_BUFFER_NOT_FOUND: Live segment buffer not found: " + liveBufferId;
    return false;
  }
  try {
    std::vector<SegRecord> records;
    if (mode == "windowSnapshot") {
      records = live->snapshotWindow();
    } else if (mode == "fullIfSpooled" || mode.empty()) {
      records = live->snapshotFullIfSpooled();
    } else {
      if (error)
        *error =
            "SEGMENT_INVALID_ARGUMENT: Unknown mode: " + mode +
            ". Use 'fullIfSpooled' or 'windowSnapshot'.";
      return false;
    }
    auto off = std::make_shared<SegOfflineEntry>();
    off->bufferId = seg_generate_id("seg_off");
    off->sourceAudioBufferId = live->sourceAudioBufferId;
    off->segments = std::move(records);
    off->populated = true;
    {
      std::lock_guard<std::mutex> lock(g_seg_mutex);
      g_seg_offline[off->bufferId] = off;
    }
    if (bufferIdOut) *bufferIdOut = off->bufferId;
    return true;
  } catch (const std::exception &e) {
    if (error) *error = e.what();
    return false;
  }
}

bool seg_populate_offline_from_live_if_empty(const std::string &offlineBufferId,
                                             const std::string &liveBufferId,
                                             const std::string &mode, std::string *error) {
  auto live = seg_get_live_entry(liveBufferId);
  auto off = seg_get_offline_entry(offlineBufferId);
  if (!live) {
    if (error) *error = "SEGMENT_BUFFER_NOT_FOUND: Live segment buffer not found: " + liveBufferId;
    return false;
  }
  if (!off) {
    if (error)
      *error = "SEGMENT_BUFFER_NOT_FOUND: Offline segment buffer not found: " + offlineBufferId;
    return false;
  }
  if (off->populated || !off->segments.empty()) {
    return true;
  }
  try {
    std::vector<SegRecord> records;
    if (mode == "windowSnapshot") {
      records = live->snapshotWindow();
    } else if (mode == "fullIfSpooled" || mode.empty()) {
      records = live->snapshotFullIfSpooled();
    } else {
      if (error)
        *error =
            "SEGMENT_INVALID_ARGUMENT: Unknown mode: " + mode +
            ". Use 'fullIfSpooled' or 'windowSnapshot'.";
      return false;
    }
    off->segments = std::move(records);
    off->populated = true;
    if (off->sourceAudioBufferId.empty()) {
      off->sourceAudioBufferId = live->sourceAudioBufferId;
    }
    return true;
  } catch (const std::exception &e) {
    if (error) *error = e.what();
    return false;
  }
}

void seg_release_all_entries() {
  std::vector<std::shared_ptr<SegLiveEntry>> liveEntries;
  {
    std::lock_guard<std::mutex> lock(g_seg_mutex);
    for (auto &kv : g_seg_live) liveEntries.push_back(kv.second);
    g_seg_live.clear();
    g_seg_offline.clear();
  }
  for (auto &e : liveEntries) {
    try {
      e->release();
    } catch (...) {
    }
  }
}
