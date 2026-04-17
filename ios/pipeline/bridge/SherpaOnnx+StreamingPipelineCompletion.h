#pragma once

#import "../../SherpaOnnx.h"
#include "../core/SherpaOnnx+StreamingPipeline.h"

void so_start_streaming_pipeline_completion_watcher(
    SherpaOnnx *module,
    const std::string &pipelineId,
    std::shared_ptr<StreamingPipelineWorker> worker);
