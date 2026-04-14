#pragma once

#ifdef __cplusplus
#include <memory>
#include <functional>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

// Forward declarations of pipeline text entry structs (defined in text/bridge/SherpaOnnx+TextBuffer.mm).
struct TxtOfflineEntry;
struct TxtLiveEntry;

// Global pipeline text registry – shared across text/bridge/SherpaOnnx+TextBuffer.mm and stt/bridge/SherpaOnnx+STT.mm.
extern std::unordered_map<std::string, std::shared_ptr<TxtOfflineEntry>> g_txt_offline;
extern std::unordered_map<std::string, std::shared_ptr<TxtLiveEntry>> g_txt_live;
extern std::mutex g_txt_mutex;

// Helper APIs for cross-file live-text access (keeps TxtLiveEntry internals encapsulated in .mm).
std::shared_ptr<TxtLiveEntry> txt_get_live_entry(const std::string &bufferId);
bool txt_live_is_recording(const std::shared_ptr<TxtLiveEntry> &entry);
bool txt_live_write_partial(
	const std::shared_ptr<TxtLiveEntry> &entry,
	const std::string &text,
	std::string *error = nullptr
);
bool txt_live_commit_segment(
	const std::shared_ptr<TxtLiveEntry> &entry,
	const std::string &text,
	const std::vector<std::string> &tokens,
	const std::vector<float> &timestamps,
	const std::string &source,
	NSDictionary *meta = nil,
	std::string *error = nullptr
);
#endif
