#pragma once

/**
 * Shared pipeline TextBuffer registry (offline + live).
 * Stable `txt_*` API kept for iOS workers / Android JNI.
 */

#include "TxtLiveEntry.h"
#include "TxtOfflineEntry.h"

#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

extern std::unordered_map<std::string, std::shared_ptr<TxtOfflineEntry>> g_txt_offline;
extern std::unordered_map<std::string, std::shared_ptr<TxtLiveEntry>> g_txt_live;
extern std::mutex g_txt_mutex;

void txt_configure_cache_dir(const std::string &cacheDir);
std::string txt_temp_dir();
std::string txt_generate_id(const char *prefix);

std::shared_ptr<TxtLiveEntry> txt_get_live_entry(const std::string &bufferId);
std::shared_ptr<TxtOfflineEntry> txt_get_offline_entry(const std::string &bufferId);

bool txt_live_is_recording(const std::shared_ptr<TxtLiveEntry> &entry);
bool txt_live_write_partial(const std::shared_ptr<TxtLiveEntry> &entry, const std::string &text,
                            std::string *error = nullptr);
bool txt_live_commit_segment(const std::shared_ptr<TxtLiveEntry> &entry, const std::string &text,
                             const std::vector<std::string> &tokens,
                             const std::vector<float> &timestamps, const std::string &source,
                             const std::string &metaJson = {}, std::string *error = nullptr);

bool txt_read_offline_text(const std::string &bufferId, std::string *text,
                           std::string *error = nullptr);
bool txt_read_offline_text_with_lang(const std::string &bufferId, std::string *text,
                                     std::string *lang, std::string *error = nullptr);

bool txt_populate_offline_if_empty(const std::string &bufferId, const std::string &text,
                                   const std::vector<std::string> &tokens,
                                   const std::vector<float> &timestamps,
                                   const std::vector<float> &durations, const std::string &lang,
                                   const std::string &emotion, const std::string &event,
                                   std::string *error = nullptr);

bool txt_populate_offline_if_empty(const std::string &bufferId, const std::string &text,
                                   const std::vector<std::string> &tokens,
                                   const std::vector<float> &timestamps,
                                   const std::vector<float> &durations, const std::string &lang,
                                   const std::string &emotion, const std::string &event,
                                   const std::vector<TxtSpatialSpan> &spatialSpans,
                                   std::string *error = nullptr);

bool txt_create_empty_offline(std::string *bufferIdOut, std::string *error = nullptr);
bool txt_create_offline_from_text(const std::string &text, const std::string &lang,
                                  const std::string &emotion, const std::string &event,
                                  std::string *bufferIdOut, std::string *error = nullptr);
bool txt_create_live(int windowMaxChars, int maxSegments, bool emitPartialEvents,
                     int64_t partialEventMinIntervalMs, const std::string &spoolMode,
                     const std::string &spoolPathOrEmpty, bool spoolTemporary,
                     std::string *bufferIdOut, std::string *error = nullptr);
bool txt_finalize_live(const std::string &liveBufferId, std::string *error = nullptr);
bool txt_release_buffer(const std::string &bufferId);
bool txt_create_offline_from_live(const std::string &liveBufferId, const std::string &mode,
                                  std::string *bufferIdOut, std::string *error = nullptr);

void txt_release_all_entries();

/** Optional: bridge installs callback for pipelineLiveTextPartial (iOS/Android). */
using TxtPartialEmitFn = void (*)(const std::string &bufferId, const char *source,
                                  const std::string &partialText, int64_t revision,
                                  int64_t minIntervalMs);
void txt_set_partial_emit_fn(TxtPartialEmitFn fn);
