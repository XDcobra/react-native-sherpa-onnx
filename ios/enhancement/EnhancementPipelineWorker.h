#pragma once

#include "../SherpaOnnx+StreamingPipeline.h"
#include "../audio/pipeline/PaLiveEntry.h"
#include "sherpa-onnx-enhancement-wrapper.h"
#include <condition_variable>
#include <deque>
#include <thread>

/**
 * EnhancementPipelineWorker — iOS C++ streaming pipeline worker for online speech enhancement.
 *
 * Mirrors Android's EnhancementPipelineWorker.kt:
 * - Dedicated thread with condition variable wakeup (zero-latency via PaLiveEntry::addAppendListener)
 * - Command queue for blocking flush / reset (std::promise<void>)
 * - Auto-flush + auto-stop when input buffer finalizes
 */
class EnhancementPipelineWorker : public StreamingPipelineWorker {
public:
  EnhancementPipelineWorker(
    std::shared_ptr<sherpaonnx::OnlineEnhancementWrapper> wrapper,
    std::shared_ptr<PaLiveEntry> inputEntry,
    std::shared_ptr<PaLiveEntry> outputEntry
  );

  ~EnhancementPipelineWorker() override;

  void start() override;
  void stop() override;
  std::future<void> flush() override;
  std::future<void> reset() override;
  StreamingPipelineStatus getStatus() override;
  void release() override;

private:
  struct PipelineCommand {
    enum Type { Flush, Reset };
    Type type;
    std::promise<void> completion;
  };

  void runLoop();
  void processCommands();
  void drainRemainingCommands();
  void joinThread();

  std::shared_ptr<sherpaonnx::OnlineEnhancementWrapper> wrapper_;
  std::shared_ptr<PaLiveEntry> inputEntry_;
  std::shared_ptr<PaLiveEntry> outputEntry_;

  std::thread workerThread_;
  std::mutex mtx_;
  std::condition_variable cv_;

  std::mutex cmdMtx_;
  std::deque<PipelineCommand> commandQueue_;

  int cursorId_ = -1;
  int appendListenerToken_ = -1;

  std::mutex statusMtx_;
  int64_t chunksProcessed_ = 0;
  int64_t unitsRead_ = 0;
  int64_t unitsWritten_ = 0;
  std::string error_;

  std::once_flag stopOnce_;
};
