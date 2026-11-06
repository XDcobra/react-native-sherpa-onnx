#pragma once

/**
 * Shared offline text buffer entry (immutable after populate).
 */

#include "TxtLiveEntry.h"  // TxtSpatialSpan
#include "TxtUtf16.h"

#include <mutex>
#include <string>
#include <vector>

struct TxtOfflineEntry {
  std::string bufferId;
  std::string text;
  std::vector<std::string> tokens;
  std::vector<float> timestamps;
  std::vector<float> durations;
  std::vector<TxtSpatialSpan> spatialSpans;
  std::string lang;
  std::string emotion;
  std::string event;
  bool populated = false;
  /** Serialize tryPopulate so work can run outside g_txt_mutex.
   * Perf keep: docs/internal/textbuffer/performance/textbuffer-perf-plan.md (C5). */
  std::mutex populateMutex;

  int utf16Length() const { return txt_utf16_length(text); }
  int tokenCount() const { return (int)tokens.size(); }
  int timestampCount() const { return (int)timestamps.size(); }
  int durationCount() const { return (int)durations.size(); }
  int spatialSpanCount() const { return (int)spatialSpans.size(); }
  bool hasLang() const { return !lang.empty(); }
  bool hasEmotion() const { return !emotion.empty(); }
  bool hasEvent() const { return !event.empty(); }
  bool hasSpatialSpans() const { return !spatialSpans.empty(); }

  void populate(const std::string &t, const std::vector<std::string> &tok,
                const std::vector<float> &ts, const std::vector<float> &dur,
                const std::string &l, const std::string &em, const std::string &ev,
                const std::vector<TxtSpatialSpan> &spans = {}) {
    (void)tryPopulate(t, tok, ts, dur, l, em, ev, spans);
  }

  /** @return false if already populated (concurrent second caller). */
  bool tryPopulate(const std::string &t, const std::vector<std::string> &tok,
                   const std::vector<float> &ts, const std::vector<float> &dur,
                   const std::string &l, const std::string &em, const std::string &ev,
                   const std::vector<TxtSpatialSpan> &spans = {}) {
    std::lock_guard<std::mutex> lock(populateMutex);
    if (populated) return false;
    text = t;
    tokens = tok;
    timestamps = ts;
    durations = dur;
    spatialSpans = spans;
    lang = l;
    emotion = em;
    event = ev;
    populated = true;
    return true;
  }
};
