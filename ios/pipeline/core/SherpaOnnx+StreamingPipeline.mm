#include "SherpaOnnx+StreamingPipeline.h"

// Global streaming pipeline registry definition
std::unordered_map<std::string, std::shared_ptr<StreamingPipelineWorker>> g_streaming_pipelines;
std::mutex g_streaming_pipeline_mutex;
std::unordered_set<std::string> g_streaming_pipeline_stop_requests;
std::mutex g_streaming_pipeline_stop_requests_mutex;

void so_mark_streaming_pipeline_stop_requested(const std::string &pipelineId) {
	if (pipelineId.empty()) {
		return;
	}
	std::lock_guard<std::mutex> lock(g_streaming_pipeline_stop_requests_mutex);
	g_streaming_pipeline_stop_requests.insert(pipelineId);
}

bool so_take_streaming_pipeline_stop_requested(const std::string &pipelineId) {
	if (pipelineId.empty()) {
		return false;
	}

	std::lock_guard<std::mutex> lock(g_streaming_pipeline_stop_requests_mutex);
	auto it = g_streaming_pipeline_stop_requests.find(pipelineId);
	if (it == g_streaming_pipeline_stop_requests.end()) {
		return false;
	}
	g_streaming_pipeline_stop_requests.erase(it);
	return true;
}
