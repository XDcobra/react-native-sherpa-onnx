#include "TextRegistry.h"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <random>
#include <sstream>

namespace {

std::string g_txt_cache_dir;
TxtPartialEmitFn g_txt_partial_emit = nullptr;

std::string makeUuidLike() {
  static thread_local std::mt19937_64 rng{std::random_device{}()};
  std::uniform_int_distribution<uint64_t> dist;
  uint64_t a = dist(rng);
  uint64_t b = dist(rng);
  char buf[40];
  std::snprintf(buf, sizeof(buf), "%016llx%016llx", (unsigned long long)a, (unsigned long long)b);
  return std::string(buf);
}

TxtLiveEntry::SpoolingMode parseSpoolMode(const std::string &mode) {
  if (mode == "off") return TxtLiveEntry::SPOOL_OFF;
  if (mode == "auto") return TxtLiveEntry::SPOOL_AUTO;
  return TxtLiveEntry::SPOOL_ON;
}

}  // namespace

std::unordered_map<std::string, std::shared_ptr<TxtOfflineEntry>> g_txt_offline;
std::unordered_map<std::string, std::shared_ptr<TxtLiveEntry>> g_txt_live;
std::mutex g_txt_mutex;

#if defined(__GNUC__) || defined(__clang__)
#define TXT_WEAK_ATTR __attribute__((weak))
#else
#define TXT_WEAK_ATTR
#endif

TXT_WEAK_ATTR void seg_engine_on_text_write(const std::string & /*liveBufferId*/) {}
TXT_WEAK_ATTR void seg_engine_on_buffer_finalized(const std::string & /*bufferId*/) {}
TXT_WEAK_ATTR void seg_engine_on_buffer_released(const std::string & /*bufferId*/) {}

void txt_dispatch_pipeline_live_text_partial(const std::string &bufferId, const char *source,
                                             int utf16Length, int64_t revisionValue,
                                             int64_t partialEventMinIntervalMs) {
  if (g_txt_partial_emit) {
    g_txt_partial_emit(bufferId, source, utf16Length, revisionValue, partialEventMinIntervalMs);
  }
}

void txt_set_partial_emit_fn(TxtPartialEmitFn fn) { g_txt_partial_emit = fn; }

void txt_configure_cache_dir(const std::string &cacheDir) { g_txt_cache_dir = cacheDir; }

std::string txt_temp_dir() {
  if (!g_txt_cache_dir.empty()) return g_txt_cache_dir;
  const char *tmp = std::getenv("TMPDIR");
  if (tmp && *tmp) return std::string(tmp);
  return "/tmp";
}

std::string txt_generate_id(const char *prefix) {
  return std::string(prefix) + makeUuidLike();
}

std::shared_ptr<TxtLiveEntry> txt_get_live_entry(const std::string &bufferId) {
  std::lock_guard<std::mutex> lock(g_txt_mutex);
  auto it = g_txt_live.find(bufferId);
  if (it == g_txt_live.end()) return nullptr;
  return it->second;
}

std::shared_ptr<TxtOfflineEntry> txt_get_offline_entry(const std::string &bufferId) {
  std::lock_guard<std::mutex> lock(g_txt_mutex);
  auto it = g_txt_offline.find(bufferId);
  if (it == g_txt_offline.end()) return nullptr;
  return it->second;
}

bool txt_acquire_offline_text_view(const std::string &bufferId, bool allowEmpty,
                                   TxtOfflineTextView *out, std::string *errorCode,
                                   std::string *errorMessage) {
  if (!out) {
    if (errorCode) *errorCode = "TEXT_INVALID_ARGUMENT";
    if (errorMessage) *errorMessage = "out must be non-null";
    return false;
  }
  *out = TxtOfflineTextView{};
  auto entry = txt_get_offline_entry(bufferId);
  if (!entry) {
    if (errorCode) *errorCode = "TEXT_BUFFER_NOT_FOUND";
    if (errorMessage) *errorMessage = "Offline text buffer not found";
    return false;
  }
  out->entry = std::move(entry);
  out->populated = out->entry->populated;
  out->lang = out->entry->lang.c_str();
  if (!out->entry->populated || out->entry->text.empty()) {
    if (!allowEmpty) {
      if (errorCode) *errorCode = "TEXT_BUFFER_EMPTY";
      if (errorMessage) *errorMessage = "Text buffer is empty or not populated";
      *out = TxtOfflineTextView{};
      return false;
    }
    out->data = nullptr;
    out->bytes = 0;
    return true;
  }
  out->data = out->entry->text.data();
  out->bytes = out->entry->text.size();
  return true;
}

bool txt_create_live_from_offline(const std::string &offlineBufferId, int windowMaxChars,
                                  int maxSegments, bool emitPartialEvents,
                                  int64_t partialEventMinIntervalMs, const std::string &spoolMode,
                                  const std::string &spoolPathOrEmpty, bool spoolTemporary,
                                  std::string *liveBufferIdOut, std::string *errorCode,
                                  std::string *errorMessage) {
  TxtOfflineTextView view;
  if (!txt_acquire_offline_text_view(offlineBufferId, /*allowEmpty=*/true, &view, errorCode,
                                     errorMessage)) {
    return false;
  }
  std::string liveId;
  std::string createErr;
  if (!txt_create_live(windowMaxChars, maxSegments, emitPartialEvents, partialEventMinIntervalMs,
                       spoolMode, spoolPathOrEmpty, spoolTemporary, &liveId, &createErr)) {
    if (errorCode) *errorCode = "TEXT_CREATE_LIVE_FAILED";
    if (errorMessage) *errorMessage = createErr.empty() ? "Failed to create live text buffer" : createErr;
    return false;
  }
  if (view.bytes > 0 && view.data != nullptr) {
    auto live = txt_get_live_entry(liveId);
    std::string writeErr;
    if (!txt_live_write_partial(live, std::string(view.data, view.bytes), &writeErr)) {
      txt_release_buffer(liveId);
      if (errorCode) *errorCode = "TEXT_WRITE_PARTIAL_FAILED";
      if (errorMessage) {
        *errorMessage = writeErr.empty() ? "Failed to seed live text from offline" : writeErr;
      }
      return false;
    }
  }
  if (liveBufferIdOut) *liveBufferIdOut = liveId;
  return true;
}

bool txt_live_is_recording(const std::shared_ptr<TxtLiveEntry> &entry) {
  return entry && entry->state == TxtLiveEntry::RECORDING;
}

bool txt_live_write_partial(const std::shared_ptr<TxtLiveEntry> &entry, const std::string &text,
                            std::string *error) {
  if (!entry) {
    if (error) *error = "Live text buffer not found";
    return false;
  }
  try {
    entry->writePartial(text);
    return true;
  } catch (const std::exception &e) {
    if (error) *error = e.what();
    return false;
  } catch (...) {
    if (error) *error = "Unknown live text writePartial error";
    return false;
  }
}

bool txt_live_append_text(const std::shared_ptr<TxtLiveEntry> &entry, const std::string &text,
                          std::string *error) {
  if (!entry) {
    if (error) *error = "Live text buffer not found";
    return false;
  }
  try {
    entry->appendText(text);
    return true;
  } catch (const std::exception &e) {
    if (error) *error = e.what();
    return false;
  } catch (...) {
    if (error) *error = "Unknown live text appendText error";
    return false;
  }
}

bool txt_live_commit_segment(const std::shared_ptr<TxtLiveEntry> &entry, const std::string &text,
                             const std::vector<std::string> &tokens,
                             const std::vector<float> &timestamps, const std::string &source,
                             const std::string &metaJson, std::string *error) {
  if (!entry) {
    if (error) *error = "Live text buffer not found";
    return false;
  }
  try {
    entry->commitSegment(text, tokens, timestamps, source, metaJson);
    return true;
  } catch (const std::exception &e) {
    if (error) *error = e.what();
    return false;
  } catch (...) {
    if (error) *error = "Unknown live text commitSegment error";
    return false;
  }
}

bool txt_live_snapshot_text(const std::shared_ptr<TxtLiveEntry> &entry, std::string *textOut,
                            std::string *error) {
  if (!entry || !textOut) {
    if (error) *error = "Live text buffer not found";
    return false;
  }
  try {
    *textOut = entry->snapshotText();
    return true;
  } catch (const std::exception &e) {
    if (error) *error = e.what();
    return false;
  } catch (...) {
    if (error) *error = "Unknown live text snapshotText error";
    return false;
  }
}

int txt_live_partial_utf16_length(const std::shared_ptr<TxtLiveEntry> &entry) {
  if (!entry) return -1;
  try {
    return entry->partialUtf16Length();
  } catch (...) {
    return -1;
  }
}

bool txt_read_offline_text(const std::string &bufferId, std::string *text, std::string *error) {
  auto entry = txt_get_offline_entry(bufferId);
  if (!entry) {
    if (error) *error = "Offline text buffer not found";
    return false;
  }
  if (!entry->populated || entry->text.empty()) {
    if (error) *error = "Text buffer is empty or not populated";
    return false;
  }
  if (text) *text = entry->text;
  return true;
}

bool txt_read_offline_text_with_lang(const std::string &bufferId, std::string *text,
                                     std::string *lang, std::string *error) {
  auto entry = txt_get_offline_entry(bufferId);
  if (!entry) {
    if (error) *error = "Offline text buffer not found";
    return false;
  }
  if (!entry->populated || entry->text.empty()) {
    if (error) *error = "Text buffer is empty or not populated";
    return false;
  }
  if (text) *text = entry->text;
  if (lang) *lang = entry->lang;
  return true;
}

bool txt_copy_offline_text_utf16_slice(const std::string &bufferId, int startUtf16, int maxUtf16,
                                       std::string *out, std::string *error) {
  if (!out) {
    if (error) *error = "Output string is null";
    return false;
  }
  auto entry = txt_get_offline_entry(bufferId);
  if (!entry) {
    if (error) *error = "Offline text buffer not found";
    return false;
  }
  *out = txt_utf16_slice(entry->text, startUtf16, maxUtf16);
  return true;
}

bool txt_copy_live_snapshot_utf16_slice(const std::string &liveBufferId, int startUtf16,
                                        int maxUtf16, std::string *out, std::string *error) {
  if (!out) {
    if (error) *error = "Output string is null";
    return false;
  }
  auto live = txt_get_live_entry(liveBufferId);
  if (!live) {
    if (error) *error = "Live text buffer not found";
    return false;
  }
  try {
    *out = txt_utf16_slice(live->snapshotText(), startUtf16, maxUtf16);
    return true;
  } catch (const std::exception &e) {
    if (error) *error = e.what();
    return false;
  } catch (...) {
    if (error) *error = "Unknown live text snapshot slice error";
    return false;
  }
}

bool txt_populate_offline_if_empty(const std::string &bufferId, const std::string &text,
                                   const std::vector<std::string> &tokens,
                                   const std::vector<float> &timestamps,
                                   const std::vector<float> &durations, const std::string &lang,
                                   const std::string &emotion, const std::string &event,
                                   std::string *error) {
  return txt_populate_offline_if_empty(bufferId, text, tokens, timestamps, durations, lang, emotion,
                                       event, std::vector<TxtSpatialSpan>{}, error);
}

bool txt_populate_offline_if_empty(const std::string &bufferId, const std::string &text,
                                   const std::vector<std::string> &tokens,
                                   const std::vector<float> &timestamps,
                                   const std::vector<float> &durations, const std::string &lang,
                                   const std::string &emotion, const std::string &event,
                                   const std::vector<TxtSpatialSpan> &spatialSpans,
                                   std::string *error) {
  std::lock_guard<std::mutex> lock(g_txt_mutex);
  auto it = g_txt_offline.find(bufferId);
  if (it == g_txt_offline.end() || !it->second) {
    if (error) *error = "Offline text buffer not found";
    return false;
  }
  if (it->second->populated) {
    if (error) *error = "Text buffer already populated";
    return false;
  }
  it->second->populate(text, tokens, timestamps, durations, lang, emotion, event, spatialSpans);
  return true;
}

bool txt_create_empty_offline(std::string *bufferIdOut, std::string *error) {
  auto entry = std::make_shared<TxtOfflineEntry>();
  entry->bufferId = txt_generate_id("txt_off_");
  {
    std::lock_guard<std::mutex> lock(g_txt_mutex);
    g_txt_offline[entry->bufferId] = entry;
  }
  if (bufferIdOut) *bufferIdOut = entry->bufferId;
  return true;
}

bool txt_create_offline_from_text(const std::string &text, const std::string &lang,
                                  const std::string &emotion, const std::string &event,
                                  std::string *bufferIdOut, std::string *error) {
  auto entry = std::make_shared<TxtOfflineEntry>();
  entry->bufferId = txt_generate_id("txt_off_");
  entry->populate(text, {}, {}, {}, lang, emotion, event, {});
  {
    std::lock_guard<std::mutex> lock(g_txt_mutex);
    g_txt_offline[entry->bufferId] = entry;
  }
  if (bufferIdOut) *bufferIdOut = entry->bufferId;
  return true;
}

bool txt_create_live(int windowMaxChars, int maxSegments, bool emitPartialEvents,
                     int64_t partialEventMinIntervalMs, const std::string &spoolMode,
                     const std::string &spoolPathOrEmpty, bool spoolTemporary,
                     std::string *bufferIdOut, std::string *error) {
  auto entry = std::make_shared<TxtLiveEntry>();
  entry->bufferId = txt_generate_id("txt_live_");
  entry->windowMaxChars = windowMaxChars > 0 ? windowMaxChars : 65536;
  entry->maxSegments = maxSegments > 0 ? maxSegments : 1000;
  entry->emitPartialEvents = emitPartialEvents;
  entry->partialEventMinIntervalMs = partialEventMinIntervalMs;
  entry->spoolingMode = parseSpoolMode(spoolMode);
  entry->spoolTemporary = spoolTemporary;
  if (entry->spoolEnabled()) {
    entry->spoolPath =
        spoolPathOrEmpty.empty()
            ? (txt_temp_dir() + "/txt_spool_" + makeUuidLike() + ".bin")
            : spoolPathOrEmpty;
  }
  {
    std::lock_guard<std::mutex> lock(g_txt_mutex);
    g_txt_live[entry->bufferId] = entry;
  }
  if (bufferIdOut) *bufferIdOut = entry->bufferId;
  return true;
}

bool txt_finalize_live(const std::string &liveBufferId, std::string *error) {
  auto entry = txt_get_live_entry(liveBufferId);
  if (!entry) {
    if (error) *error = "Live text buffer not found";
    return false;
  }
  try {
    entry->finalize_();
    return true;
  } catch (const std::exception &e) {
    if (error) *error = e.what();
    return false;
  }
}

bool txt_release_buffer(const std::string &bufferId) {
  std::shared_ptr<TxtLiveEntry> live;
  {
    std::lock_guard<std::mutex> lock(g_txt_mutex);
    auto o = g_txt_offline.find(bufferId);
    if (o != g_txt_offline.end()) {
      g_txt_offline.erase(o);
      return true;
    }
    auto l = g_txt_live.find(bufferId);
    if (l != g_txt_live.end()) {
      live = l->second;
      g_txt_live.erase(l);
    } else {
      return false;
    }
  }
  if (live) {
    try {
      live->release();
    } catch (...) {
    }
  }
  return true;
}

bool txt_create_offline_from_live(const std::string &liveBufferId, const std::string &mode,
                                  std::string *bufferIdOut, std::string *error) {
  auto live = txt_get_live_entry(liveBufferId);
  if (!live) {
    if (error) *error = "Live text buffer not found";
    return false;
  }
  std::string text;
  try {
    if (mode == "windowSnapshot") {
      text = live->snapshotText();
    } else if (mode == "fullIfSpooled") {
      text = live->snapshotFullTextIfSpooled();
    } else {
      if (error) *error = "Unknown mode: " + mode;
      return false;
    }
  } catch (const std::exception &e) {
    if (error) *error = e.what();
    return false;
  }
  return txt_create_offline_from_text(text, "", "", "", bufferIdOut, error);
}

void txt_release_all_entries() {
  std::unordered_map<std::string, std::shared_ptr<TxtLiveEntry>> liveToRelease;
  {
    std::lock_guard<std::mutex> lock(g_txt_mutex);
    liveToRelease = std::move(g_txt_live);
    g_txt_live.clear();
    g_txt_offline.clear();
  }
  for (auto &pair : liveToRelease) {
    try {
      if (pair.second) pair.second->release();
    } catch (...) {
    }
  }
}
