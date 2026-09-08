#include "DiarizationStreamingPipelineWorker.h"
#include "../../segmentbuffer/core/SherpaOnnx+SegmentBufferGlobals.h"

#include <chrono>
#include <cmath>

DiarizationStreamingPipelineWorker::DiarizationStreamingPipelineWorker(
    const std::string &instanceId,
    std::shared_ptr<PaLiveEntry> inputEntry,
    Config config,
    EventEmitter emitEvent)
    : instanceId_(instanceId),
      inputEntry_(std::move(inputEntry)),
      config_(std::move(config)),
      emitEvent_(std::move(emitEvent)) {}

DiarizationStreamingPipelineWorker::~DiarizationStreamingPipelineWorker() {
  release();
}

void DiarizationStreamingPipelineWorker::start() {
  if (running.load()) {
    return;
  }

  if (config_.wrapper) {
    config_.wrapper->reset();
  }
  running.store(true);
  cursorId_ = inputEntry_->createCursorHandle();
  appendListenerToken_ = inputEntry_->addAppendListener([this]() {
    cv_.notify_one();
  });

  emit("pipeline.started");
  workerThread_ = std::thread([this]() { runLoop(); });
}

void DiarizationStreamingPipelineWorker::stop() {
  running.store(false);
  cv_.notify_all();
  if (workerThread_.joinable()) {
    workerThread_.join();
  }
}

void DiarizationStreamingPipelineWorker::release() {
  stop();
  drainRemainingCommands();
}

std::future<void> DiarizationStreamingPipelineWorker::flush() {
  auto cmd = std::make_unique<Cmd>();
  cmd->type = Cmd::FLUSH;
  auto fut = cmd->done.get_future();
  {
    std::lock_guard<std::mutex> lock(cmdMutex_);
    cmdQueue_.push_back(std::move(cmd));
  }
  cv_.notify_one();
  return fut;
}

std::future<void> DiarizationStreamingPipelineWorker::reset() {
  auto cmd = std::make_unique<Cmd>();
  cmd->type = Cmd::RESET;
  auto fut = cmd->done.get_future();
  {
    std::lock_guard<std::mutex> lock(cmdMutex_);
    cmdQueue_.push_back(std::move(cmd));
  }
  cv_.notify_one();
  return fut;
}

StreamingPipelineStatus DiarizationStreamingPipelineWorker::getStatus() {
  std::lock_guard<std::mutex> lock(statusMutex_);
  StreamingPipelineStatus status;
  status.isRunning = running.load();
  status.chunksProcessed = chunksProcessed_;
  status.unitsRead = unitsRead_;
  status.unitsWritten = unitsWritten_;
  status.error = error_;
  return status;
}

void DiarizationStreamingPipelineWorker::emit(
    const std::string &type,
    const std::unordered_map<std::string, double> &numeric,
    const std::unordered_map<std::string, std::string> &text,
    const std::unordered_map<std::string, bool> &boolean) {
  if (emitEvent_) {
    emitEvent_(type, numeric, text, boolean);
  }
}

void DiarizationStreamingPipelineWorker::runLoop() {
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
      error_ = "Unknown diarization pipeline error";
    }
    emit("pipeline.error", {}, {{"error", "Unknown diarization pipeline error"}});
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

void DiarizationStreamingPipelineWorker::processChunk(const std::vector<float> &chunk) {
  if (chunk.empty() || !config_.wrapper) {
    return;
  }

  {
    std::lock_guard<std::mutex> lock(statusMutex_);
    chunksProcessed_++;
    unitsRead_ += static_cast<int64_t>(chunk.size());
  }

  auto res = config_.wrapper->feed(chunk.data(), chunk.size());
  if (!res.success) {
    throw std::runtime_error(res.error.empty() ? "Streaming diarization feed failed" : res.error);
  }

  handleSegments(res.segments);
}

void DiarizationStreamingPipelineWorker::flushInternal() {
  if (!config_.wrapper) return;

  auto res = config_.wrapper->flush();
  if (!res.success) {
    throw std::runtime_error(res.error.empty() ? "Streaming diarization flush failed" : res.error);
  }

  handleSegments(res.segments);
}

void DiarizationStreamingPipelineWorker::handleSegments(
    const std::vector<sherpaonnx::StreamingDiarizationSegmentDto> &segments) {
  if (segments.empty()) return;

  const int sampleRate = config_.sampleRate > 0 ? config_.sampleRate : 16000;

  for (const auto &seg : segments) {
    int startSample = static_cast<int>(std::round(seg.start * sampleRate));
    int endSample = static_cast<int>(std::round(seg.end * sampleRate));
    int durationMs = static_cast<int>(std::round((seg.end - seg.start) * 1000.0f));

    std::string payloadJson =
        "{\"source\":\"diarization\",\"speaker\":" + std::to_string(seg.speaker) + "}";

    std::string err;
    bool ok = seg_live_append_segment(
        config_.segmentOutBufferId,
        "diarization",
        config_.sourceAudioBufferId,
        startSample,
        endSample,
        sampleRate,
        durationMs,
        false,
        0.0,
        payloadJson,
        nullptr,
        nullptr,
        &err);

    if (ok) {
      std::lock_guard<std::mutex> lock(statusMutex_);
      segmentCount_++;
      unitsWritten_++;
    }
  }
}

void DiarizationStreamingPipelineWorker::processCommands() {
  std::deque<std::unique_ptr<Cmd>> cmds;
  {
    std::lock_guard<std::mutex> lock(cmdMutex_);
    cmds.swap(cmdQueue_);
  }

  for (auto &cmd : cmds) {
    try {
      if (cmd->type == Cmd::FLUSH) {
        flushInternal();
      } else if (cmd->type == Cmd::RESET) {
        if (config_.wrapper) {
          config_.wrapper->reset();
        }
      }
      cmd->done.set_value();
    } catch (...) {
      cmd->done.set_exception(std::current_exception());
    }
  }
}

void DiarizationStreamingPipelineWorker::drainRemainingCommands() {
  std::deque<std::unique_ptr<Cmd>> cmds;
  {
    std::lock_guard<std::mutex> lock(cmdMutex_);
    cmds.swap(cmdQueue_);
  }
  for (auto &cmd : cmds) {
    cmd->done.set_value();
  }
}
