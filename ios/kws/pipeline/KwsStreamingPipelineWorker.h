#pragma once

#include "../../pipeline/core/SherpaOnnx+StreamingPipeline.h"
#include "../../audio/pipeline/PaLiveEntry.h"
#include "../../textbuffer/core/SherpaOnnx+TextBufferGlobals.h"
#include "../native/sherpa-onnx-kws-wrapper.h"

#include <condition_variable>
#include <deque>
#include <mutex>
#include <thread>

/**
 * KwsStreamingPipelineWorker — iOS streaming pipeline for keyword spotting.
 *
 * Mirrors Android KwsStreamingPipelineWorker: drain live audio, decode on the
 * native thread, commit keyword hits to LiveTextBuffer, reset after each hit.
 */
class KwsStreamingPipelineWorker : public StreamingPipelineWorker {
 public:
  KwsStreamingPipelineWorker(
      sherpaonnx::KwsWrapper *wrapper,
      const std::string &streamId,
      std::shared_ptr<PaLiveEntry> inputEntry,
      std::shared_ptr<TxtLiveEntry> outputEntry,
      int chunkSize);

  ~KwsStreamingPipelineWorker() override;

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
  void autoFlushAndCommit(bool endOfAudio);
  void maybeCommitHit(const sherpaonnx::KwsStreamResult &result);
  void processCommands();
  void drainRemainingCommands();
  void joinThread();

  sherpaonnx::KwsWrapper *wrapper_;
  std::string streamId_;
  std::shared_ptr<PaLiveEntry> inputEntry_;
  std::shared_ptr<TxtLiveEntry> outputEntry_;
  int chunkSize_ = 6400;

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
  int hitCount_ = 0;

  std::once_flag stopOnce_;
};
