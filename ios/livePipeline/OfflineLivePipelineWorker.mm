#include "OfflineLivePipelineWorker.h"

#include <algorithm>
#include <chrono>
#include <stdexcept>

OfflineLivePipelineWorker::OfflineLivePipelineWorker(
  std::string pipelineId,
  std::string attachedSegmentationEngineId,
  std::shared_ptr<PaLiveEntry> audioInput,
  std::string audioSegmentInputBufferId,
  std::shared_ptr<TxtLiveEntry> textInput
)
  : attachedSegmentationEngineId_(std::move(attachedSegmentationEngineId)),
    audioInput_(std::move(audioInput)),
    audioSegmentInputBufferId_(std::move(audioSegmentInputBufferId)),
    textInput_(std::move(textInput))
{
  this->pipelineId = std::move(pipelineId);
}

OfflineLivePipelineWorker::~OfflineLivePipelineWorker() {
  release();
}

void OfflineLivePipelineWorker::start() {
  bool expected = false;
  if (!running.compare_exchange_strong(expected, true)) {
    return;
  }

  stopRequested_.store(false);

  if (!audioSegmentInputBufferId_.empty()) {
    std::string err;
    audioCursorId_ = seg_live_create_cursor(audioSegmentInputBufferId_, &err);
    if (audioCursorId_ < 0) {
      throw std::runtime_error(err.empty() ? "Failed to create audio segment cursor" : err);
    }
  }

  if (textInput_) {
    textCursorId_ = textInput_->createSegmentCursor();
  }

  attachCommitListener();

  workerThread_ = std::thread([this]() {
    try {
      runLoop();
    } catch (const std::exception &e) {
      std::lock_guard<std::mutex> statusLock(statusMtx_);
      error_ = e.what();
    } catch (...) {
      std::lock_guard<std::mutex> statusLock(statusMtx_);
      error_ = "OfflineLivePipelineWorker failed";
    }
    running.store(false);
  });
}

void OfflineLivePipelineWorker::stop() {
  if (stopRequested_.exchange(true)) {
    return;
  }
  waitCv_.notify_all();
}

std::future<void> OfflineLivePipelineWorker::flush() {
  PipelineCommand cmd;
  cmd.type = PipelineCommand::Flush;
  auto future = cmd.completion.get_future();
  {
    std::lock_guard<std::mutex> cmdLock(cmdMtx_);
    commandQueue_.push_back(std::move(cmd));
  }
  waitCv_.notify_all();
  return future;
}

std::future<void> OfflineLivePipelineWorker::reset() {
  PipelineCommand cmd;
  cmd.type = PipelineCommand::Reset;
  auto future = cmd.completion.get_future();
  {
    std::lock_guard<std::mutex> cmdLock(cmdMtx_);
    commandQueue_.push_back(std::move(cmd));
  }
  waitCv_.notify_all();
  return future;
}

void OfflineLivePipelineWorker::addUnitsWritten(int64_t units) {
  if (units <= 0) return;
  std::lock_guard<std::mutex> statusLock(statusMtx_);
  unitsWritten_ += units;
}

StreamingPipelineStatus OfflineLivePipelineWorker::getStatus() {
  std::lock_guard<std::mutex> statusLock(statusMtx_);
  return StreamingPipelineStatus{
    running.load(),
    chunksProcessed_,
    unitsRead_,
    unitsWritten_,
    error_,
  };
}

void OfflineLivePipelineWorker::release() {
  stop();
  waitCv_.notify_all();

  if (workerThread_.joinable() && workerThread_.get_id() != std::this_thread::get_id()) {
    workerThread_.join();
  }

  detachCommitListener();
  releaseCursors();
  detachSegmentationEngineSafe(false);
  onRelease();
}

void OfflineLivePipelineWorker::runLoop() {
  while (!stopRequested_.load()) {
    processCommands();

    DrainedSegment drained;
    if (!drainNextSegment(&drained)) {
      if (isInputFinalized()) {
        break;
      }

      std::unique_lock<std::mutex> lock(waitMtx_);
      waitCv_.wait_for(lock, std::chrono::milliseconds(100));
      continue;
    }

    try {
      onSegmentCommitted(drained.segment);
      std::lock_guard<std::mutex> statusLock(statusMtx_);
      chunksProcessed_ += 1;
      unitsRead_ += drained.unitsRead;
    } catch (const std::exception &e) {
      std::lock_guard<std::mutex> statusLock(statusMtx_);
      error_ = e.what();
    }
  }

  drainTail();
  drainRemainingCommands();
}

void OfflineLivePipelineWorker::processCommands() {
  while (true) {
    PipelineCommand cmd;
    {
      std::lock_guard<std::mutex> cmdLock(cmdMtx_);
      if (commandQueue_.empty()) {
        return;
      }
      cmd = std::move(commandQueue_.front());
      commandQueue_.pop_front();
    }

    if (cmd.type == PipelineCommand::Flush) {
      try {
        detachSegmentationEngineSafe(true);
        drainTail();
        cmd.completion.set_value();
      } catch (...) {
        cmd.completion.set_exception(std::current_exception());
      }
    } else {
      // Per sub-02 OQ-2.4, reset is intentionally a no-op in the shared base.
      cmd.completion.set_value();
    }
  }
}

void OfflineLivePipelineWorker::drainTail() {
  while (true) {
    DrainedSegment drained;
    if (!drainNextSegment(&drained)) {
      return;
    }
    try {
      onSegmentCommitted(drained.segment);
      std::lock_guard<std::mutex> statusLock(statusMtx_);
      chunksProcessed_ += 1;
      unitsRead_ += drained.unitsRead;
    } catch (const std::exception &e) {
      std::lock_guard<std::mutex> statusLock(statusMtx_);
      error_ = e.what();
    }
  }
}

bool OfflineLivePipelineWorker::isInputFinalized() const {
  if (!audioInput_.get() && !textInput_.get()) {
    return true;
  }
  if (audioInput_) {
    return audioInput_->state == PaLiveEntry::FINISHED;
  }
  if (textInput_) {
    return textInput_->state == TxtLiveEntry::FINISHED;
  }
  return true;
}

bool OfflineLivePipelineWorker::drainNextSegment(DrainedSegment *out) {
  if (!out) return false;

  if (!audioSegmentInputBufferId_.empty() && audioCursorId_ >= 0) {
    std::string err;
    int startIndex = -1;
    auto records = seg_live_drain_segments(
      audioSegmentInputBufferId_,
      audioCursorId_,
      1,
      &startIndex,
      &err
    );
    if (!err.empty()) {
      throw std::runtime_error(err);
    }
    if (!records.empty()) {
      const auto &record = records.front();
      out->segment = CommittedSegmentSpeech{
        record.sourceAudioBufferId,
        record.startSample,
        record.endSample,
        record.sampleRate,
        record.durationMs,
        record.id,
        startIndex,
        record.payloadJson,
      };
      out->unitsRead = std::max(0, record.endSample - record.startSample);
      return true;
    }
  }

  if (textInput_ && textCursorId_ >= 0) {
    auto segments = textInput_->drainSegments(textCursorId_, 1);
    if (!segments.empty()) {
      const auto &segment = segments.front();
      out->segment = CommittedSegmentText{
        segment.text,
        std::string("txtseg_") + textInput_->bufferId + "_" + std::to_string(segment.segmentIndex),
        segment.segmentIndex,
        0,
        static_cast<int>(segment.text.size()),
        segment.source,
        segment.meta,
      };
      out->unitsRead = static_cast<int64_t>(segment.text.size());
      return true;
    }
  }

  return false;
}

void OfflineLivePipelineWorker::attachCommitListener() {
  if (!audioSegmentInputBufferId_.empty()) {
    std::string err;
    audioCommitListenerToken_ = seg_live_add_commit_listener(
      audioSegmentInputBufferId_,
      [this](const std::string &, int, const SegRecord &) {
        waitCv_.notify_all();
      },
      &err
    );
    if (audioCommitListenerToken_ < 0) {
      throw std::runtime_error(err.empty() ? "Failed to attach audio segment commit listener" : err);
    }
  }

  if (textInput_) {
    textCommitListenerToken_ = textInput_->addCommitListener([this](const TextSegment &) {
      waitCv_.notify_all();
    });
  }
}

void OfflineLivePipelineWorker::detachCommitListener() {
  if (!audioSegmentInputBufferId_.empty() && audioCommitListenerToken_ >= 0) {
    seg_live_remove_commit_listener(audioSegmentInputBufferId_, audioCommitListenerToken_);
    audioCommitListenerToken_ = -1;
  }

  if (textInput_ && textCommitListenerToken_ >= 0) {
    textInput_->removeCommitListener(textCommitListenerToken_);
    textCommitListenerToken_ = -1;
  }
}

void OfflineLivePipelineWorker::releaseCursors() {
  if (!audioSegmentInputBufferId_.empty() && audioCursorId_ >= 0) {
    seg_live_release_cursor(audioSegmentInputBufferId_, audioCursorId_);
    audioCursorId_ = -1;
  }

  if (textInput_ && textCursorId_ >= 0) {
    textInput_->releaseSegmentCursor(textCursorId_);
    textCursorId_ = -1;
  }
}

void OfflineLivePipelineWorker::drainRemainingCommands() {
  while (true) {
    PipelineCommand cmd;
    {
      std::lock_guard<std::mutex> cmdLock(cmdMtx_);
      if (commandQueue_.empty()) {
        return;
      }
      cmd = std::move(commandQueue_.front());
      commandQueue_.pop_front();
    }

    try {
      throw std::runtime_error("Pipeline stopped before command could complete");
    } catch (...) {
      cmd.completion.set_exception(std::current_exception());
    }
  }
}

void OfflineLivePipelineWorker::detachSegmentationEngineSafe(bool flushFinal) {
  bool expected = false;
  if (!segmentationDetached_.compare_exchange_strong(expected, true)) {
    return;
  }
  std::string err;
  seg_engine_detach(attachedSegmentationEngineId_, flushFinal, &err);
}
