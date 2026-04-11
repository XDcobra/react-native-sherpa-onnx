#pragma once

#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

// Forward declarations of pipeline text entry structs (defined in SherpaOnnx+TextBuffer.mm).
struct TxtOfflineEntry;
struct TxtLiveEntry;

// Global pipeline text registry – shared across SherpaOnnx+TextBuffer.mm and SherpaOnnx+STT.mm.
extern std::unordered_map<std::string, std::shared_ptr<TxtOfflineEntry>> g_txt_offline;
extern std::unordered_map<std::string, std::shared_ptr<TxtLiveEntry>> g_txt_live;
extern std::mutex g_txt_mutex;
