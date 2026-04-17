#import "SherpaOnnx+StreamingPipelineCompletion.h"

#include <chrono>
#include <thread>

void so_start_streaming_pipeline_completion_watcher(
    SherpaOnnx *module,
    const std::string &pipelineId,
    std::shared_ptr<StreamingPipelineWorker> worker) {
  if (module == nil || worker == nullptr || pipelineId.empty()) {
    return;
  }

  __weak SherpaOnnx *weakModule = module;

  std::thread([weakModule, pipelineId, worker]() {
    using namespace std::chrono_literals;

    while (worker->isRunning()) {
      std::this_thread::sleep_for(20ms);
    }

    StreamingPipelineStatus status;
    try {
      status = worker->getStatus();
    } catch (const std::exception &e) {
      status.isRunning = false;
      status.error = e.what();
    } catch (...) {
      status.isRunning = false;
      status.error = "Unknown pipeline completion error";
    }

    const bool stopRequested = so_take_streaming_pipeline_stop_requested(pipelineId);
    std::string reason;
    if (stopRequested) {
      reason = "stopped";
    } else if (!status.error.empty()) {
      reason = "error";
    } else {
      reason = "completed";
    }

    dispatch_async(dispatch_get_main_queue(), ^{
      SherpaOnnx *strongModule = weakModule;
      if (strongModule == nil) {
        return;
      }

      NSString *pipelineIdNs =
          [NSString stringWithUTF8String:pipelineId.c_str()];
      NSString *reasonNs = [NSString stringWithUTF8String:reason.c_str()];
      NSString *errorNs =
          status.error.empty()
              ? nil
              : [NSString stringWithUTF8String:status.error.c_str()];

      NSMutableDictionary *payload = [NSMutableDictionary dictionaryWithDictionary:@{
        @"pipelineId": pipelineIdNs ?: @"",
        @"reason": reasonNs ?: @"completed",
        @"chunksProcessed": @((double)status.chunksProcessed),
        @"unitsRead": @((double)status.unitsRead),
        @"unitsWritten": @((double)status.unitsWritten),
      }];
      payload[@"error"] = errorNs ?: [NSNull null];

      [strongModule sendEventWithName:@"streamingPipelineCompleted" body:payload];
    });

    {
      std::lock_guard<std::mutex> lock(g_streaming_pipeline_mutex);
      auto it = g_streaming_pipelines.find(pipelineId);
      if (it != g_streaming_pipelines.end() && it->second.get() == worker.get()) {
        g_streaming_pipelines.erase(it);
      }
    }
    worker->release();
  }).detach();
}
