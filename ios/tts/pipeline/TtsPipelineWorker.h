#pragma once

#include "../../SherpaOnnx+StreamingPipeline.h"
#include "../../audio/pipeline/PaLiveEntry.h"
#include "../../SherpaOnnx+TextBufferGlobals.h"
#include "../native/sherpa-onnx-tts-wrapper.h"
#include <condition_variable>
#include <deque>
#include <optional>
#include <thread>

/**
 * TtsPipelineWorker — iOS C++ streaming pipeline worker for TTS.
 *
 * Mirrors Android's TtsPipelineWorker.kt:
 * - Dedicated thread with condition variable wakeup via TxtLiveEntry::appendListeners
 * - Command queue for blocking flush / reset (std::promise<void>)
 * - Auto-drain + auto-stop when input text buffer finalizes
 * - Reads committed text segments from TxtLiveEntry, synthesizes each one
 *   via TtsWrapper::generateStream, writes PCM to PaLiveEntry
 */
class TtsPipelineWorker : public StreamingPipelineWorker {
public:
  TtsPipelineWorker(
    sherpaonnx::TtsWrapper *wrapper,
    std::shared_ptr<TxtLiveEntry> inputEntry,
    std::shared_ptr<PaLiveEntry> outputEntry,
    int32_t defaultSid,
    float defaultSpeed,
    std::optional<sherpaonnx::VoiceCloneOptions> voiceClone
  );

  ~TtsPipelineWorker() override;

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
  void synthesizeSegment(const std::string &text, NSDictionary *meta, int32_t sampleRate);
  void processCommands();
  void drainRemainingCommands();
  void joinThread();

  sherpaonnx::TtsWrapper *wrapper_;
  std::shared_ptr<TxtLiveEntry> inputEntry_;
  std::shared_ptr<PaLiveEntry> outputEntry_;
  int32_t defaultSid_ = 0;
  float defaultSpeed_ = 1.0f;
  std::optional<sherpaonnx::VoiceCloneOptions> voiceClone_;

  std::thread workerThread_;
  std::mutex mtx_;
  std::condition_variable cv_;

  std::mutex cmdMtx_;
  std::deque<PipelineCommand> commandQueue_;

  int textCursorId_ = -1;
  int appendListenerToken_ = -1;

  std::mutex statusMtx_;
  int64_t chunksProcessed_ = 0;
  int64_t unitsRead_ = 0;
  int64_t unitsWritten_ = 0;
  std::string error_;

  std::once_flag stopOnce_;
};
