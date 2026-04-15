#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

struct StreamingPipelineStatus {
  bool isRunning = false;
  int64_t chunksProcessed = 0;
  int64_t unitsRead = 0;
  int64_t unitsWritten = 0;
  std::string error;
};

class StreamingPipelineWorker {
public:
  std::string pipelineId;
  std::atomic<bool> running{false};

  virtual ~StreamingPipelineWorker() = default;
  virtual void start() = 0;
  virtual void stop() = 0;
  virtual std::future<void> flush() = 0;
  virtual std::future<void> reset() = 0;
  virtual StreamingPipelineStatus getStatus() = 0;
  virtual void release() = 0;

  bool isRunning() const { return running.load(); }
};

// Global streaming pipeline registry
extern std::unordered_map<std::string, std::shared_ptr<StreamingPipelineWorker>> g_streaming_pipelines;
extern std::mutex g_streaming_pipeline_mutex;
