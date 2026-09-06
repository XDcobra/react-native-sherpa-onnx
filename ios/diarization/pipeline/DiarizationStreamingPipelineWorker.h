#pragma once

#include "../../pipeline/core/SherpaOnnx+StreamingPipeline.h"
#include "../../audio/pipeline/PaLiveEntry.h"
#include "sherpa-onnx-streaming-diarization-wrapper.h"

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>

class DiarizationStreamingPipelineWorker : public StreamingPipelineWorker {
public:
  struct Config {
    int sampleRate = 16000;
    int chunkSize = 4096;
    std::string sourceAudioBufferId;
    std::string segmentOutBufferId;
    std::shared_ptr<sherpaonnx::StreamingDiarizationWrapper> wrapper;
  };

  using EventEmitter = std::function<void(
      const std::string &,
      const std::unordered_map<std::string, double> &,
      const std::unordered_map<std::string, std::string> &,
      const std::unordered_map<std::string, bool> &)>;

  DiarizationStreamingPipelineWorker(
      const std::string &instanceId,
      std::shared_ptr<PaLiveEntry> inputEntry,
      Config config,
      EventEmitter emitEvent);

  ~DiarizationStreamingPipelineWorker() override;

  void start() override;
  void stop() override;
  std::future<void> flush() override;
  std::future<void> reset() override;
  StreamingPipelineStatus getStatus() override;
  void release() override;

private:
  void runLoop();
  void processChunk(const std::vector<float> &chunk);
  void flushInternal();
  void handleSegments(const std::vector<sherpaonnx::StreamingDiarizationSegmentDto> &segments);
  void processCommands();
  void drainRemainingCommands();

  void emit(const std::string &type,
            const std::unordered_map<std::string, double> &numeric = {},
            const std::unordered_map<std::string, std::string> &text = {},
            const std::unordered_map<std::string, bool> &boolean = {});

  struct Cmd {
    enum Type { FLUSH, RESET };
    Type type;
    std::promise<void> done;
  };

  std::string instanceId_;
  std::shared_ptr<PaLiveEntry> inputEntry_;
  Config config_;
  EventEmitter emitEvent_;

  std::thread workerThread_;
  int cursorId_ = -1;
  int appendListenerToken_ = -1;

  std::mutex waitMutex_;
  std::condition_variable cv_;

  std::mutex cmdMutex_;
  std::deque<std::unique_ptr<Cmd>> cmdQueue_;

  std::mutex statusMutex_;
  int64_t chunksProcessed_ = 0;
  int64_t unitsRead_ = 0;
  int64_t unitsWritten_ = 0;
  int64_t segmentCount_ = 0;
  std::string error_;
};
