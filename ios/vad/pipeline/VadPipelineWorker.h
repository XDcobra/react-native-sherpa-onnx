#pragma once

#include "../../pipeline/core/SherpaOnnx+StreamingPipeline.h"
#include "../../audio/pipeline/PaLiveEntry.h"
#include "../core/VadRuntime.h"

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <future>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>

class VadPipelineWorker : public StreamingPipelineWorker {
public:
  struct Config {
    int sampleRate = 16000;
    int chunkSize = 512;
    std::string sourceAudioBufferId;
    std::string segmentOutBufferId;
    std::shared_ptr<VadRuntime> runtime;
  };

  using EventEmitter = std::function<void(const std::string &, const std::unordered_map<std::string, double> &, const std::unordered_map<std::string, std::string> &, const std::unordered_map<std::string, bool> &)>;

  VadPipelineWorker(
    const std::string &instanceId,
    std::shared_ptr<PaLiveEntry> inputEntry,
    Config config,
    EventEmitter emitEvent
  );

  ~VadPipelineWorker() override;

  void start() override;
  void stop() override;
  std::future<void> flush() override;
  std::future<void> reset() override;
  StreamingPipelineStatus getStatus() override;
  void release() override;

  bool isSpeechDetectedNow() const;
  int queueDepthNow() const;
  int64_t segmentCountNow() const;
  int64_t speechDurationMsNow() const;

private:
  struct PipelineCommand {
    enum Type { Flush, Reset };
    Type type;
    std::promise<void> completion;
  };

  void runLoop();
  void processCommands();
  void drainRemainingCommands();
  void processChunk(const std::vector<float> &chunk);
  void appendDetectedSegments();
  void flushInternal();
  void emit(
    const std::string &type,
    const std::unordered_map<std::string, double> &numbers = {},
    const std::unordered_map<std::string, std::string> &strings = {},
    const std::unordered_map<std::string, bool> &flags = {}
  );

  std::string instanceId_;
  std::shared_ptr<PaLiveEntry> inputEntry_;
  Config config_;
  EventEmitter emitEvent_;

  std::thread workerThread_;
  std::mutex waitMutex_;
  std::condition_variable cv_;
  std::once_flag stopOnce_;

  std::mutex cmdMutex_;
  std::deque<PipelineCommand> commandQueue_;

  std::mutex statusMutex_;
  int64_t chunksProcessed_ = 0;
  int64_t unitsRead_ = 0;
  int64_t unitsWritten_ = 0;
  int64_t segmentCount_ = 0;
  int64_t speechDurationMs_ = 0;
  std::string error_;

  std::atomic<int> queueDepth_{0};
  std::atomic<bool> speechDetected_{false};

  int cursorId_ = -1;
  int appendListenerToken_ = -1;
};
