#include "VadPipelineWorker.h"

#include "../../segmentbuffer/core/SherpaOnnx+SegmentBufferGlobals.h"

#include <algorithm>
#include <chrono>
#include <cmath>
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
  double energy = 0.0;
  for (float sample : chunk) {
    energy += std::fabs(sample);
  }
  energy /= static_cast<double>(chunk.size());

  const bool detected = energy >= config_.threshold;
  const bool prior = speechDetected_.exchange(detected);
  if (prior != detected) {
    emit("vad.stateChanged", {}, {}, {{"isSpeechDetected", detected}});
  }

  if (detected) {
    if (speechSamples_ == 0) {
      segmentStartSample_ = absoluteSample_;
    }
    speechSamples_ += static_cast<int64_t>(chunk.size());
    silenceSamples_ = 0;
  } else if (speechSamples_ > 0) {
    silenceSamples_ += static_cast<int64_t>(chunk.size());
    const int64_t silenceMs = samplesToMs(silenceSamples_);
    if (silenceMs >= static_cast<int64_t>(config_.minSilenceDurationMs)) {
      appendSegment(absoluteSample_ + static_cast<int64_t>(chunk.size()));
      speechSamples_ = 0;
      silenceSamples_ = 0;
    }
  }

  absoluteSample_ += static_cast<int64_t>(chunk.size());
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
  if (speechSamples_ > 0) {
    appendSegment(absoluteSample_);
    speechSamples_ = 0;
    silenceSamples_ = 0;
  }
  emit("pipeline.flushed");
}

void VadPipelineWorker::appendSegment(int64_t segmentEndSample) {
  const int64_t durationSamples = std::max<int64_t>(0, segmentEndSample - segmentStartSample_);
  const int64_t durationMs = samplesToMs(durationSamples);
  if (durationMs < static_cast<int64_t>(config_.minSpeechDurationMs)) {
    return;
  }

  std::string segmentId;
  int segmentIndex = -1;
  std::string error;
  const bool ok = seg_live_append_segment(
    config_.segmentOutBufferId,
    "speech",
    config_.sourceAudioBufferId,
    static_cast<int>(segmentStartSample_),
    static_cast<int>(segmentEndSample),
    config_.sampleRate,
    static_cast<int>(durationMs),
    true,
    1.0,
    "{\"engine\":\"vad\"}",
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
    speechDurationMs_ += durationMs;
  }
}

int64_t VadPipelineWorker::samplesToMs(int64_t samples) const {
  return (samples * 1000LL) / static_cast<int64_t>(std::max(1, config_.sampleRate));
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
        speechDetected_.store(false);
        speechSamples_ = 0;
        silenceSamples_ = 0;
        segmentStartSample_ = absoluteSample_;
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
