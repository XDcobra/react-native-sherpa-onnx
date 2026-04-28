#pragma once

#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

// Forward declarations of pipeline entry structs (defined in SherpaOnnx+PipelineAudio.mm).
struct PaOfflineEntry;
struct PaLiveEntry;

// Global pipeline audio registry – shared across SherpaOnnx+PipelineAudio.mm and SherpaOnnx+STT.mm.
extern std::unordered_map<std::string, std::shared_ptr<PaOfflineEntry>> g_pa_offline;
extern std::unordered_map<std::string, std::shared_ptr<PaLiveEntry>> g_pa_live;
extern std::unordered_set<std::string> g_pa_invalidated_live_ids;
extern std::mutex g_pa_mutex;

// Helper APIs for cross-file pipeline-audio access.
std::shared_ptr<PaLiveEntry> pa_get_live_entry(const std::string &bufferId);
bool pa_is_live_invalidated(const std::string &bufferId);
bool pa_read_offline_samples(
	const std::string &bufferId,
	std::vector<float> *samples,
	int *sampleRate
);

bool pa_create_offline_from_samples(
	const float *samples,
	size_t count,
	int sampleRate,
	int channelCount,
	std::string *json,
	std::string *errorCode,
	std::string *errorMessage
);

bool pa_get_offline_samples_slice(
	const std::string &bufferId,
	int startFrame,
	int frameCount,
	std::vector<float> *out,
	std::string *errorCode,
	std::string *errorMessage
);

bool pa_get_live_samples_slice(
	const std::string &bufferId,
	int startFrame,
	int frameCount,
	std::vector<float> *out,
	std::string *errorCode,
	std::string *errorMessage
);

bool pa_append_samples_to_live(
	const std::string &bufferId,
	const float *samples,
	size_t count,
	int sampleRate,
	std::string *errorCode,
	std::string *errorMessage
);

// Query offline buffer metadata by id.
bool pa_get_offline_metadata(
	const std::string &bufferId,
	int *sampleRate,
	int *numSamples,
	std::string *errorCode,
	std::string *errorMessage
);

// Populate an empty offline buffer atomically.
bool pa_adopt_offline_samples_if_empty(
	const std::string &bufferId,
	std::vector<float> &&samples,
	std::string *errorCode,
	std::string *errorMessage
);

// Orphan sweep for mmap temp files.
void pa_sweepOrphanedTempFiles(int maxAgeSec = 3600);

// Orphan sweep for orchestration temp files (orch_*).
void pa_sweepOrphanedOrchestrationFiles(int maxAgeSec = 3600);
void pa_cleanupOrphanedOrchestrationFiles(int maxAgeSec = 3600);

// Upgrade an in-memory entry to mmap if it exceeds the threshold.
void pa_upgradeToMmapIfNeeded(const std::string &bufferId);
