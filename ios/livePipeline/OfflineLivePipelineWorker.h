#pragma once

#include "../pipeline/core/SherpaOnnx+StreamingPipeline.h"
#include "../audio/pipeline/PaLiveEntry.h"
#include "../segmentbuffer/core/SherpaOnnx+SegmentBufferGlobals.h"
#include "../textbuffer/core/SherpaOnnx+TextBufferGlobals.h"

#include <atomic>
#include <condition_variable>
#include <deque>
#include <future>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <variant>

struct CommittedSegmentSpeech {
  std::string sourceAudioBufferId;
  int startSample = 0;
  int endSample = 0;
  int sampleRate = 0;
  int durationMs = 0;
  std::string segmentId;
  int segmentIndex = 0;
  std::string payloadJson;
};

struct CommittedSegmentText {
  std::string text;
  std::string segmentId;
  int segmentIndex = 0;
  int startOffset = 0;
  int endOffset = 0;
  std::string source;
  NSDictionary *meta = nil;
};

using CommittedSegmentRef = std::variant<CommittedSegmentSpeech, CommittedSegmentText>;

class OfflineLivePipelineWorker : public StreamingPipelineWorker {
public:
  OfflineLivePipelineWorker(
    std::string pipelineId,
    std::string attachedSegmentationEngineId,
    std::shared_ptr<PaLiveEntry> audioInput,
    std::string audioSegmentInputBufferId,
    std::shared_ptr<TxtLiveEntry> textInput
  );

  ~OfflineLivePipelineWorker() override;

  void start() override;
  void stop() override;
  std::future<void> flush() override;
  std::future<void> reset() override;
  StreamingPipelineStatus getStatus() override;
  void release() override;

protected:
  virtual void onSegmentCommitted(const CommittedSegmentRef &segment) = 0;
  virtual void onRelease() {}

private:
  struct PipelineCommand {
    enum Type { Flush, Reset };
    Type type;
    std::promise<void> completion;
  };

  struct DrainedSegment {
    CommittedSegmentRef segment;
    int64_t unitsRead = 0;
  };

  void runLoop();
  void processCommands();
  void drainTail();
  bool isInputFinalized() const;
  bool drainNextSegment(DrainedSegment *out);

  void attachCommitListener();
  void detachCommitListener();
  void releaseCursors();
  void drainRemainingCommands();
  void detachSegmentationEngineSafe(bool flushFinal);

  std::string attachedSegmentationEngineId_;

  std::shared_ptr<PaLiveEntry> audioInput_;
  std::string audioSegmentInputBufferId_;
  std::shared_ptr<TxtLiveEntry> textInput_;

  std::thread workerThread_;
  std::atomic<bool> stopRequested_{false};
  std::atomic<bool> segmentationDetached_{false};

  std::mutex waitMtx_;
  std::condition_variable waitCv_;

  std::mutex cmdMtx_;
  std::deque<PipelineCommand> commandQueue_;

  std::mutex statusMtx_;
  int64_t chunksProcessed_ = 0;
  int64_t unitsRead_ = 0;
  int64_t unitsWritten_ = 0;
  std::string error_;

  int audioCursorId_ = -1;
  int textCursorId_ = -1;
  int audioCommitListenerToken_ = -1;
  int textCommitListenerToken_ = -1;
};
