#pragma once

#include "../../SherpaOnnx+StreamingPipeline.h"
#include "../../audio/pipeline/PaLiveEntry.h"
#include "../../SherpaOnnx+TextBufferGlobals.h"
#include "../native/sherpa-onnx-online-stt-wrapper.h"
#include <condition_variable>
#include <deque>
#include <thread>

/**
 * SttPipelineWorker — iOS C++ streaming pipeline worker for online STT.
 *
 * Mirrors Android's SttPipelineWorker.kt:
 * - Dedicated thread with condition variable wakeup via PaLiveEntry::addAppendListener
 * - Command queue for blocking flush / reset (std::promise<void>)
 * - Auto-flush + auto-stop when input audio buffer finalizes
 * - Writes partial text and committed segments to TxtLiveEntry
 */
class SttPipelineWorker : public StreamingPipelineWorker {
public:
  SttPipelineWorker(
    sherpaonnx::OnlineSttWrapper *wrapper,
    const std::string &streamId,
    std::shared_ptr<PaLiveEntry> inputEntry,
    std::shared_ptr<TxtLiveEntry> outputEntry,
    int chunkSize
  );

  ~SttPipelineWorker() override;

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
  void autoFlushAndCommit();
  void processCommands();
  void drainRemainingCommands();
  void joinThread();

  sherpaonnx::OnlineSttWrapper *wrapper_;
  std::string streamId_;
  std::shared_ptr<PaLiveEntry> inputEntry_;
  std::shared_ptr<TxtLiveEntry> outputEntry_;
  int chunkSize_ = 3200;

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
