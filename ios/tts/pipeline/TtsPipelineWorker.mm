#include "TtsPipelineWorker.h"
#include <algorithm>
#include <chrono>
#include <stdexcept>

TtsPipelineWorker::TtsPipelineWorker(
  sherpaonnx::TtsWrapper *wrapper,
  std::shared_ptr<TxtLiveEntry> inputEntry,
  std::shared_ptr<PaLiveEntry> outputEntry,
  int32_t defaultSid,
  float defaultSpeed,
  std::optional<sherpaonnx::VoiceCloneOptions> voiceClone
)
  : wrapper_(wrapper),
    inputEntry_(std::move(inputEntry)),
    outputEntry_(std::move(outputEntry)),
    defaultSid_(defaultSid),
    defaultSpeed_(defaultSpeed),
    voiceClone_(std::move(voiceClone))
{
  pipelineId = std::string("tts_") +
    std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
}

TtsPipelineWorker::~TtsPipelineWorker() {
  release();
}

void TtsPipelineWorker::start() {
  running.store(true);
  textCursorId_ = inputEntry_->createSegmentCursor();

  appendListenerToken_ = inputEntry_->addAppendListener([this]() {
    cv_.notify_one();
  });

  workerThread_ = std::thread([this]() { runLoop(); });
}

void TtsPipelineWorker::runLoop() {
  try {
    if (!wrapper_) {
      throw std::runtime_error("TTS wrapper is null");
    }

    const int32_t sampleRate = wrapper_->getSampleRate();

    while (running.load()) {
      processCommands();

      auto segments = inputEntry_->drainSegments(textCursorId_, 1);
      if (segments.empty()) {
        if (inputEntry_->state == TxtLiveEntry::FINISHED) {
          break;
        }
        std::unique_lock<std::mutex> lock(mtx_);
        cv_.wait_for(lock, std::chrono::milliseconds(50));
        continue;
      }

      auto &seg = segments[0];
      if (seg.text.empty() ||
          seg.text.find_first_not_of(" \t\n\r") == std::string::npos) {
        continue;
      }

      synthesizeSegment(seg.text, seg.meta, sampleRate);

      {
        std::lock_guard<std::mutex> sLock(statusMtx_);
        chunksProcessed_++;
      }
    }
  } catch (const std::exception &e) {
    std::lock_guard<std::mutex> sLock(statusMtx_);
    error_ = e.what();
  } catch (...) {
    std::lock_guard<std::mutex> sLock(statusMtx_);
    error_ = "Unknown error in TTS pipeline";
  }

  running.store(false);

  if (textCursorId_ >= 0) {
    inputEntry_->releaseSegmentCursor(textCursorId_);
    textCursorId_ = -1;
  }

  if (appendListenerToken_ >= 0) {
    inputEntry_->removeAppendListener(appendListenerToken_);
    appendListenerToken_ = -1;
  }

  drainRemainingCommands();
}

void TtsPipelineWorker::synthesizeSegment(
  const std::string &text,
  NSDictionary *meta,
  int32_t sampleRate
) {
  {
    std::lock_guard<std::mutex> sLock(statusMtx_);
    unitsRead_ += (int64_t)text.size();
  }

  // Resolve per-segment overrides from meta, fall back to pipeline defaults
  int32_t effectiveSid = defaultSid_;
  float effectiveSpeed = defaultSpeed_;
  if (meta) {
    NSNumber *sidVal = meta[@"sid"];
    if (sidVal) effectiveSid = [sidVal intValue];
    NSNumber *spdVal = meta[@"speed"];
    if (spdVal) effectiveSpeed = [spdVal floatValue];
  }

  // Chunk callback: write PCM directly to output audio buffer
  auto callback = [this, sampleRate](const float *samples, int32_t n, float) -> int32_t {
    if (!running.load()) return 0;
    outputEntry_->appendSamples(samples, n, sampleRate, kPaAppendSourceTts);
    {
      std::lock_guard<std::mutex> sLock(statusMtx_);
      unitsWritten_ += n;
    }
    return n;
  };

  if (voiceClone_.has_value()) {
    // Build clone options with per-segment extra overrides
    auto cloneOpts = voiceClone_.value();
    if (meta) {
      NSDictionary *extraDict = meta[@"extra"];
      if (extraDict && [extraDict isKindOfClass:[NSDictionary class]]) {
        for (NSString *key in extraDict) {
          NSString *val = extraDict[key];
          if ([val isKindOfClass:[NSString class]]) {
            cloneOpts.extra[[key UTF8String]] = [val UTF8String];
          }
        }
      }
    }
    cloneOpts.silence_scale = voiceClone_->silence_scale;
    cloneOpts.num_steps = voiceClone_->num_steps;
    wrapper_->generateStream(text, effectiveSid, effectiveSpeed, callback, cloneOpts);
  } else {
    wrapper_->generateStream(text, effectiveSid, effectiveSpeed, callback);
  }
}

void TtsPipelineWorker::processCommands() {
  std::lock_guard<std::mutex> lock(cmdMtx_);
  while (!commandQueue_.empty()) {
    auto &cmd = commandQueue_.front();
    switch (cmd.type) {
      case PipelineCommand::Flush: {
        try {
          const int32_t sampleRate = wrapper_->getSampleRate();
          while (true) {
            auto remaining = inputEntry_->drainSegments(textCursorId_, 1);
            if (remaining.empty()) break;
            auto &seg = remaining[0];
            if (seg.text.empty() ||
                seg.text.find_first_not_of(" \t\n\r") == std::string::npos) {
              continue;
            }
            synthesizeSegment(seg.text, seg.meta, sampleRate);
            {
              std::lock_guard<std::mutex> sLock(statusMtx_);
              chunksProcessed_++;
            }
          }
          cmd.completion.set_value();
        } catch (...) {
          cmd.completion.set_exception(std::current_exception());
        }
        break;
      }
      case PipelineCommand::Reset: {
        try {
          // Advance cursor past all available segments (discard)
          while (!inputEntry_->drainSegments(textCursorId_, 100).empty()) { /* skip */ }
          cmd.completion.set_value();
        } catch (...) {
          cmd.completion.set_exception(std::current_exception());
        }
        break;
      }
    }
    commandQueue_.pop_front();
  }
}

void TtsPipelineWorker::drainRemainingCommands() {
  std::lock_guard<std::mutex> lock(cmdMtx_);
  while (!commandQueue_.empty()) {
    auto &cmd = commandQueue_.front();
    try {
      cmd.completion.set_exception(
        std::make_exception_ptr(std::runtime_error("Pipeline stopped before command could complete"))
      );
    } catch (...) {
      // promise already satisfied — ignore
    }
    commandQueue_.pop_front();
  }
}

void TtsPipelineWorker::joinThread() {
  if (workerThread_.joinable()) {
    workerThread_.join();
  }
}

void TtsPipelineWorker::stop() {
  std::call_once(stopOnce_, [this]() {
    running.store(false);
    cv_.notify_one();
    joinThread();
  });
}

std::future<void> TtsPipelineWorker::flush() {
  if (!running.load()) {
    std::promise<void> p;
    p.set_exception(std::make_exception_ptr(
      std::runtime_error("Pipeline is not running")
    ));
    return p.get_future();
  }

  PipelineCommand cmd;
  cmd.type = PipelineCommand::Flush;
  auto future = cmd.completion.get_future();
  {
    std::lock_guard<std::mutex> lock(cmdMtx_);
    commandQueue_.push_back(std::move(cmd));
  }
  cv_.notify_one();
  return future;
}

std::future<void> TtsPipelineWorker::reset() {
  if (!running.load()) {
    std::promise<void> p;
    p.set_exception(std::make_exception_ptr(
      std::runtime_error("Pipeline is not running")
    ));
    return p.get_future();
  }

  PipelineCommand cmd;
  cmd.type = PipelineCommand::Reset;
  auto future = cmd.completion.get_future();
  {
    std::lock_guard<std::mutex> lock(cmdMtx_);
    commandQueue_.push_back(std::move(cmd));
  }
  cv_.notify_one();
  return future;
}

StreamingPipelineStatus TtsPipelineWorker::getStatus() {
  std::lock_guard<std::mutex> sLock(statusMtx_);
  return StreamingPipelineStatus{
    running.load(),
    chunksProcessed_,
    unitsRead_,
    unitsWritten_,
    error_
  };
}

void TtsPipelineWorker::release() {
  stop();
}
