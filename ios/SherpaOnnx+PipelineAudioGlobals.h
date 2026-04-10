#pragma once

#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

// Forward declarations of pipeline entry structs (defined in SherpaOnnx+PipelineAudio.mm).
struct PaOfflineEntry;
struct PaLiveEntry;

// Global pipeline audio registry – shared across SherpaOnnx+PipelineAudio.mm and SherpaOnnx+STT.mm.
extern std::unordered_map<std::string, std::shared_ptr<PaOfflineEntry>> g_pa_offline;
extern std::unordered_map<std::string, std::shared_ptr<PaLiveEntry>> g_pa_live;
extern std::mutex g_pa_mutex;
