#include "VadPipelineWorker.h"

#include "../../segmentbuffer/core/SherpaOnnx+SegmentBufferGlobals.h"

#include <algorithm>
#include <chrono>
#include <stdexcept>

namespace {
std::string MakePipelineId() {
  return std::string("vad_") +
    std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
}
} // namespace

VadPipelineWorker::VadPipelineWorker(
  const std::string &instanceId,
  std::shared_ptr<PaLiveEntry> inputEntry,
  Config config,
  EventEmitter emitEvent
)
  : instanceId_(instanceId),
    inputEntry_(std::move(inputEntry)),
    config_(std::move(config)),
    emitEvent_(std::move(emitEvent))
{
  config_.chunkSize = std::max(1, config_.chunkSize);
  config_.sampleRate = std::max(1, config_.sampleRate);
  pipelineId = MakePipelineId();
}

VadPipelineWorker::~VadPipelineWorker() {
  release();
}

void VadPipelineWorker::start() {
  if (!config_.runtime) {
    throw std::runtime_error("VAD runtime is not initialized");
  }
  config_.runtime->Reset();
  running.store(true);
  cursorId_ = inputEntry_->createCursorHandle();
  appendListenerToken_ = inputEntry_->addAppendListener([this]() {
    cv_.notify_one();
  });

  emit("pipeline.started");
  workerThread_ = std::thread([this]() { runLoop(); });
}

void VadPipelineWorker::runLoop() {
  try {
    while (running.load()) {
      processCommands();

      auto chunk = inputEntry_->drainCursor(cursorId_, config_.chunkSize);
      if (chunk.empty()) {
        if (inputEntry_->state == PaLiveEntry::FINISHED) {
          flushInternal();
          break;
        }
        std::unique_lock<std::mutex> lock(waitMutex_);
        cv_.wait_for(lock, std::chrono::milliseconds(10));
        continue;
      }

      processChunk(chunk);
    }

    emit(
      "pipeline.completed",
      {
        {"chunksProcessed", static_cast<double>(chunksProcessed_)},
        {"unitsRead", static_cast<double>(unitsRead_)},
        {"unitsWritten", static_cast<double>(unitsWritten_)},
        {"segmentCount", static_cast<double>(segmentCount_)},
        {"speechDurationMs", static_cast<double>(speechDurationMs_)},
      }
    );
  } catch (const std::exception &e) {
    {
      std::lock_guard<std::mutex> lock(statusMutex_);
      error_ = e.what();
    }
    emit("pipeline.error", {}, {{"error", e.what()}});
  } catch (...) {
    {
      std::lock_guard<std::mutex> lock(statusMutex_);
      error_ = "Unknown VAD pipeline error";
    }
    emit("pipeline.error", {}, {{"error", "Unknown VAD pipeline error"}});
  }

  running.store(false);

  if (cursorId_ >= 0) {
    inputEntry_->releaseCursor(cursorId_);
    cursorId_ = -1;
  }
  if (appendListenerToken_ >= 0) {
    inputEntry_->removeAppendListener(appendListenerToken_);
    appendListenerToken_ = -1;
  }

  drainRemainingCommands();
}

void VadPipelineWorker::processChunk(const std::vector<float> &chunk) {
  if (chunk.empty()) {
    return;
  }
  // VAD-only rule:
  // VAD model compute is sensitive to undersized chunks from live mic scheduling.
  // We normalize arbitrary buffer reads into fixed VAD frames before runtime input.
  pendingVadSamples_.insert(pendingVadSamples_.end(), chunk.begin(), chunk.end());
  const int frameSize = std::max(1, config_.vadFrameSize);
  while ((int)pendingVadSamples_.size() >= frameSize) {
    config_.runtime->AcceptWaveform(
      pendingVadSamples_.data(),
      frameSize
    );
    const bool detected = config_.runtime->IsSpeechDetected();
    const bool prior = speechDetected_.exchange(detected);
    if (prior != detected) {
      emit("vad.stateChanged", {}, {}, {{"isSpeechDetected", detected}});
    }
    appendDetectedSegments();
    pendingVadSamples_.erase(
      pendingVadSamples_.begin(),
      pendingVadSamples_.begin() + frameSize
    );
  }
  {
    std::lock_guard<std::mutex> lock(statusMutex_);
    chunksProcessed_++;
    unitsRead_ += static_cast<int64_t>(chunk.size());
  }

  emit(
    "pipeline.progress",
    {
      {"chunksProcessed", static_cast<double>(chunksProcessed_)},
      {"unitsRead", static_cast<double>(unitsRead_)},
      {"unitsWritten", static_cast<double>(unitsWritten_)},
      {"queueDepth", static_cast<double>(queueDepth_.load())},
    }
  );
}

void VadPipelineWorker::flushInternal() {
  if (!pendingVadSamples_.empty()) {
    const int frameSize = std::max(1, config_.vadFrameSize);
    std::vector<float> tail(frameSize, 0.0f);
    std::copy(
      pendingVadSamples_.begin(),
      pendingVadSamples_.end(),
      tail.begin()
    );
    config_.runtime->AcceptWaveform(tail.data(), frameSize);
    pendingVadSamples_.clear();
  }
  config_.runtime->Flush();
  appendDetectedSegments();
  emit("pipeline.flushed");
}

void VadPipelineWorker::appendDetectedSegments() {
  const auto segments = config_.runtime->PopSegments();
  for (const auto &segment : segments) {
    std::string segmentId;
    int segmentIndex = -1;
    std::string error;
    const bool ok = seg_live_append_segment(
      config_.segmentOutBufferId,
      "speech",
      config_.sourceAudioBufferId,
      segment.startSample,
      segment.endSample,
      config_.sampleRate,
      segment.durationMs,
      true,
      1.0,
      "{\"source\":\"vad\",\"engine\":\"vad\",\"decision\":\"model\"}",
      &segmentId,
      &segmentIndex,
      &error
    );
    if (!ok) {
      throw std::runtime_error(
        error.empty() ? "Failed to append live VAD segment" : error
      );
    }
    {
      std::lock_guard<std::mutex> lock(statusMutex_);
      unitsWritten_++;
      segmentCount_++;
      speechDurationMs_ += static_cast<int64_t>(segment.durationMs);
    }
  }
}

void VadPipelineWorker::processCommands() {
  std::lock_guard<std::mutex> lock(cmdMutex_);
  while (!commandQueue_.empty()) {
    auto &cmd = commandQueue_.front();
    queueDepth_.fetch_sub(1);
    if (cmd.type == PipelineCommand::Flush) {
      try {
        flushInternal();
        cmd.completion.set_value();
      } catch (...) {
        cmd.completion.set_exception(std::current_exception());
      }
    } else {
      try {
        config_.runtime->Reset();
        speechDetected_.store(false);
        {
          std::lock_guard<std::mutex> sLock(statusMutex_);
          chunksProcessed_ = 0;
          unitsRead_ = 0;
          unitsWritten_ = 0;
          segmentCount_ = 0;
          speechDurationMs_ = 0;
          error_.clear();
        }
        cmd.completion.set_value();
      } catch (...) {
        cmd.completion.set_exception(std::current_exception());
      }
    }
    commandQueue_.pop_front();
  }
}

void VadPipelineWorker::drainRemainingCommands() {
  std::lock_guard<std::mutex> lock(cmdMutex_);
  while (!commandQueue_.empty()) {
    auto &cmd = commandQueue_.front();
    try {
      cmd.completion.set_exception(
        std::make_exception_ptr(
          std::runtime_error("Pipeline stopped before command could complete")
        )
      );
    } catch (...) {
    }
    commandQueue_.pop_front();
  }
}

void VadPipelineWorker::stop() {
  std::call_once(stopOnce_, [this]() {
    running.store(false);
    cv_.notify_one();
    if (workerThread_.joinable()) {
      workerThread_.join();
    }
  });
}

std::future<void> VadPipelineWorker::flush() {
  if (!running.load()) {
    std::promise<void> p;
    p.set_exception(std::make_exception_ptr(std::runtime_error("Pipeline is not running")));
    return p.get_future();
  }

  PipelineCommand cmd;
  cmd.type = PipelineCommand::Flush;
  auto future = cmd.completion.get_future();
  {
    std::lock_guard<std::mutex> lock(cmdMutex_);
    commandQueue_.push_back(std::move(cmd));
  }
  queueDepth_.fetch_add(1);
  cv_.notify_one();
  return future;
}

std::future<void> VadPipelineWorker::reset() {
  if (!running.load()) {
    std::promise<void> p;
    p.set_exception(std::make_exception_ptr(std::runtime_error("Pipeline is not running")));
    return p.get_future();
  }

  PipelineCommand cmd;
  cmd.type = PipelineCommand::Reset;
  auto future = cmd.completion.get_future();
  {
    std::lock_guard<std::mutex> lock(cmdMutex_);
    commandQueue_.push_back(std::move(cmd));
  }
  queueDepth_.fetch_add(1);
  cv_.notify_one();
  return future;
}

StreamingPipelineStatus VadPipelineWorker::getStatus() {
  std::lock_guard<std::mutex> lock(statusMutex_);
  return StreamingPipelineStatus{
    running.load(),
    chunksProcessed_,
    unitsRead_,
    unitsWritten_,
    error_,
  };
}

void VadPipelineWorker::release() {
  stop();
}

bool VadPipelineWorker::isSpeechDetectedNow() const {
  return speechDetected_.load();
}

int VadPipelineWorker::queueDepthNow() const {
  return queueDepth_.load();
}

int64_t VadPipelineWorker::segmentCountNow() const {
  std::lock_guard<std::mutex> lock(statusMutex_);
  return segmentCount_;
}

int64_t VadPipelineWorker::speechDurationMsNow() const {
  std::lock_guard<std::mutex> lock(statusMutex_);
  return speechDurationMs_;
}

void VadPipelineWorker::emit(
  const std::string &type,
  const std::unordered_map<std::string, double> &numbers,
  const std::unordered_map<std::string, std::string> &strings,
  const std::unordered_map<std::string, bool> &flags
) {
  if (!emitEvent_) {
    return;
  }
  emitEvent_(type, numbers, strings, flags);
}
