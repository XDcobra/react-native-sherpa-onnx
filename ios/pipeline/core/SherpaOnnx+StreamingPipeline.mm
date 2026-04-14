#include "SherpaOnnx+StreamingPipeline.h"

// Global streaming pipeline registry definition
std::unordered_map<std::string, std::shared_ptr<StreamingPipelineWorker>> g_streaming_pipelines;
std::mutex g_streaming_pipeline_mutex;
