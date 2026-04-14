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

// Helper APIs for cross-file pipeline-audio access.
std::shared_ptr<PaLiveEntry> pa_get_live_entry(const std::string &bufferId);
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
