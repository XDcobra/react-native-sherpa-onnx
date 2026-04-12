#include "EnhancementPipelineWorker.h"
#include <algorithm>
#include <chrono>

EnhancementPipelineWorker::EnhancementPipelineWorker(
  std::shared_ptr<sherpaonnx::OnlineEnhancementWrapper> wrapper,
  std::shared_ptr<PaLiveEntry> inputEntry,
  std::shared_ptr<PaLiveEntry> outputEntry
)
  : wrapper_(wrapper),
    inputEntry_(std::move(inputEntry)),
    outputEntry_(std::move(outputEntry))
{
  pipelineId = std::string("enhancement_") +
    std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
}

EnhancementPipelineWorker::~EnhancementPipelineWorker() {
  release();
}

void EnhancementPipelineWorker::start() {
  running.store(true);
  cursorId_ = inputEntry_->createCursorHandle();

  // Register append listener for zero-latency wakeup (token-based)
  appendListenerToken_ = inputEntry_->addAppendListener([this]() {
    cv_.notify_one();
  });

  workerThread_ = std::thread([this]() { runLoop(); });
}

void EnhancementPipelineWorker::runLoop() {
  const int chunkSize = wrapper_->getFrameShiftInSamples();
  const int sr = wrapper_->getSampleRate();

  try {
    while (running.load()) {
      // 1. Process pending commands (flush/reset)
      processCommands();

      // 2. Drain input
      auto chunk = inputEntry_->drainCursor(cursorId_, chunkSize);
      if (chunk.empty()) {
        if (inputEntry_->state == PaLiveEntry::FINISHED) {
          // Input stream ended → auto-flush and stop
          auto flushed = wrapper_->flush();
          if (!flushed.samples.empty()) {
            outputEntry_->appendSamples(flushed.samples.data(), flushed.samples.size(),
                                        sr, kPaAppendSourceEnhancement);
            std::lock_guard<std::mutex> sLock(statusMtx_);
            samplesWritten_ += (int64_t)flushed.samples.size();
          }
          break;
        }
        // Wait for signal from input buffer (zero-latency wakeup)
        std::unique_lock<std::mutex> lock(mtx_);
        cv_.wait_for(lock, std::chrono::milliseconds(10));
        continue;
      }

      // 3. Denoise and write to output
      auto denoised = wrapper_->runSamples(chunk, sr);
      outputEntry_->appendSamples(denoised.samples.data(), denoised.samples.size(),
                                  sr, kPaAppendSourceEnhancement);

      {
        std::lock_guard<std::mutex> sLock(statusMtx_);
        samplesRead_ += (int64_t)chunk.size();
        samplesWritten_ += (int64_t)denoised.samples.size();
        chunksProcessed_++;
      }
    }
  } catch (const std::exception &e) {
    std::lock_guard<std::mutex> sLock(statusMtx_);
    error_ = e.what();
  } catch (...) {
    std::lock_guard<std::mutex> sLock(statusMtx_);
    error_ = "Unknown error in enhancement pipeline";
  }

  // Cleanup
  running.store(false);
  inputEntry_->releaseCursor(cursorId_);
  cursorId_ = -1;

  if (appendListenerToken_ >= 0) {
    inputEntry_->removeAppendListener(appendListenerToken_);
    appendListenerToken_ = -1;
  }

  drainRemainingCommands();
}

void EnhancementPipelineWorker::processCommands() {
  std::lock_guard<std::mutex> lock(cmdMtx_);
  while (!commandQueue_.empty()) {
    auto &cmd = commandQueue_.front();
    switch (cmd.type) {
      case PipelineCommand::Flush: {
        try {
          auto flushed = wrapper_->flush();
          if (!flushed.samples.empty()) {
            outputEntry_->appendSamples(flushed.samples.data(), flushed.samples.size(),
                                        wrapper_->getSampleRate(), kPaAppendSourceEnhancement);
            std::lock_guard<std::mutex> sLock(statusMtx_);
            samplesWritten_ += (int64_t)flushed.samples.size();
          }
          cmd.completion.set_value();
        } catch (...) {
          cmd.completion.set_exception(std::current_exception());
        }
        break;
      }
      case PipelineCommand::Reset: {
        try {
          wrapper_->reset();
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

void EnhancementPipelineWorker::drainRemainingCommands() {
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

void EnhancementPipelineWorker::joinThread() {
  if (workerThread_.joinable()) {
    workerThread_.join();
  }
}

// Fix C1+C2: std::call_once prevents double-join and ensures join even after auto-stop
void EnhancementPipelineWorker::stop() {
  std::call_once(stopOnce_, [this]() {
    running.store(false);
    cv_.notify_one();
    joinThread();
  });
}

std::future<void> EnhancementPipelineWorker::flush() {
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

std::future<void> EnhancementPipelineWorker::reset() {
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

// Fix W1: read status counters + error under statusMtx_
StreamingPipelineStatus EnhancementPipelineWorker::getStatus() {
  std::lock_guard<std::mutex> sLock(statusMtx_);
  return StreamingPipelineStatus{
    running.load(),
    chunksProcessed_,
    samplesRead_,
    samplesWritten_,
    error_
  };
}

void EnhancementPipelineWorker::release() {
  stop();
}

void EnhancementPipelineWorker::release() {
  stop();
}
