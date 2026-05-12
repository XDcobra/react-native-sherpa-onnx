#include "SttPipelineWorker.h"
#import <Foundation/Foundation.h>
#include <algorithm>
#include <chrono>
#include <cctype>
#include <stdexcept>

namespace {
std::string TrimCopy(const std::string &s) {
  size_t a = 0, b = s.size();
  while (a < b && std::isspace(static_cast<unsigned char>(s[a]))) a++;
  while (b > a && std::isspace(static_cast<unsigned char>(s[b - 1]))) b--;
  return s.substr(a, b - a);
}
std::string PreviewForLog(const std::string &s, size_t maxChars = 96) {
  std::string t = TrimCopy(s);
  if (t.size() <= maxChars) return t;
  return t.substr(0, maxChars) + "…";
}
NSString *NsUtf8(const std::string &s) {
  NSString *n = [NSString stringWithUTF8String:s.c_str()];
  return n ?: @"";
}
}  // namespace

SttPipelineWorker::SttPipelineWorker(
  sherpaonnx::OnlineSttWrapper *wrapper,
  const std::string &streamId,
  std::shared_ptr<PaLiveEntry> inputEntry,
  std::shared_ptr<TxtLiveEntry> outputEntry,
  int chunkSize
)
  : wrapper_(wrapper),
    streamId_(streamId),
    inputEntry_(std::move(inputEntry)),
    outputEntry_(std::move(outputEntry)),
    chunkSize_(std::max(1, chunkSize))
{
  pipelineId = std::string("stt_") +
    std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
}

SttPipelineWorker::~SttPipelineWorker() {
  release();
}

void SttPipelineWorker::start() {
  running.store(true);
  cursorId_ = inputEntry_->createCursorHandle();

  appendListenerToken_ = inputEntry_->addAppendListener([this]() {
    cv_.notify_one();
  });

  workerThread_ = std::thread([this]() { runLoop(); });
}

void SttPipelineWorker::runLoop() {
  try {
    if (!wrapper_) {
      throw std::runtime_error("STT wrapper is null");
    }

    const int sampleRate = wrapper_->getSampleRate();

    while (running.load()) {
      processCommands();

      auto chunk = inputEntry_->drainCursor(cursorId_, chunkSize_);
      if (chunk.empty()) {
        if (inputEntry_->state == PaLiveEntry::FINISHED) {
          autoFlushAndCommit(true);
          break;
        }
        std::unique_lock<std::mutex> lock(mtx_);
        cv_.wait_for(lock, std::chrono::milliseconds(10));
        continue;
      }

      wrapper_->acceptWaveform(streamId_, sampleRate, chunk.data(), chunk.size());
      {
        std::lock_guard<std::mutex> sLock(statusMtx_);
        unitsRead_ += (int64_t)chunk.size();
      }

      while (wrapper_->isReady(streamId_)) {
        wrapper_->decode(streamId_);
      }

      {
        std::lock_guard<std::mutex> sLock(statusMtx_);
        chunksProcessed_++;
      }

      auto result = wrapper_->getResult(streamId_);

      if (!result.text.empty()) {
        if (dbgFirstHypothesis_.empty()) dbgFirstHypothesis_ = result.text;
      }

      if (!result.text.empty()) {
        std::string err;
        if (!txt_live_write_partial(outputEntry_, result.text, &err)) {
          throw std::runtime_error("Failed to write partial text: " + err);
        }
      }

      if (wrapper_->isEndpoint(streamId_)) {
        if (!result.text.empty()) {
          dbgEndpointCommits_++;
          const int64_t createdAtMs =
            static_cast<int64_t>(
              std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::system_clock::now().time_since_epoch()
              ).count()
            );
          NSDictionary *segmentMeta = @{
            @"__segmentReason": @"endpoint",
            @"__segmentSource": @"segmentation_engine",
            @"__segmentCreatedAtMs": @(createdAtMs),
          };
          std::string err;
          if (!txt_live_commit_segment(
                outputEntry_,
                result.text,
                result.tokens,
                result.timestamps,
                "stt_stream",
                segmentMeta,
                &err
              )) {
            throw std::runtime_error("Failed to commit text segment: " + err);
          }
          {
            std::lock_guard<std::mutex> sLock(statusMtx_);
            unitsWritten_ += (int64_t)result.text.size();
          }
          if (!txt_live_write_partial(outputEntry_, "", &err)) {
            throw std::runtime_error("Failed to clear partial text: " + err);
          }
        }
        wrapper_->resetStream(streamId_);
      }
    }
  } catch (const std::exception &e) {
    std::lock_guard<std::mutex> sLock(statusMtx_);
    error_ = e.what();
  } catch (...) {
    std::lock_guard<std::mutex> sLock(statusMtx_);
    error_ = "Unknown error in STT pipeline";
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

  if (wrapper_) {
    wrapper_->releaseStream(streamId_);
  }

  drainRemainingCommands();
}

void SttPipelineWorker::autoFlushAndCommit(bool endOfAudio) {
  if (endOfAudio && wrapper_) {
    wrapper_->inputFinished(streamId_);
  }
  int tailDecodePasses = 0;
  while (wrapper_->isReady(streamId_)) {
    wrapper_->decode(streamId_);
    tailDecodePasses++;
  }

  auto result = wrapper_->getResult(streamId_);
  if (endOfAudio) {
    const std::string &ft = dbgFirstHypothesis_;
    const std::string &rt = result.text;
    const std::string ftTrim = TrimCopy(ft);
    const std::string rtTrim = TrimCopy(rt);
    const bool finalExtendsFirstOpening =
      !ftTrim.empty() && rtTrim.size() >= ftTrim.size() &&
      rtTrim.compare(0, ftTrim.size(), ftTrim) == 0;
    int64_t chunksSnap = 0;
    int64_t unitsSnap = 0;
    {
      std::lock_guard<std::mutex> sLock(statusMtx_);
      chunksSnap = chunksProcessed_;
      unitsSnap = unitsRead_;
    }
    NSLog(
      @"[SherpaOnnx:SttPipelineWorker] sessionEnd {pipelineId=%@, unitsRead=%lld, chunks=%lld, endpointCommits=%d, tailDecodePasses=%d, firstHypLen=%zu, finalLen=%zu, finalExtendsFirst=%d, preview=%@}",
      NsUtf8(pipelineId),
      (long long)unitsSnap,
      (long long)chunksSnap,
      dbgEndpointCommits_,
      tailDecodePasses,
      ft.size(),
      rt.size(),
      finalExtendsFirstOpening ? 1 : 0,
      NsUtf8(PreviewForLog(rt, 80)));
  }

  if (!result.text.empty()) {
    const int64_t createdAtMs =
      static_cast<int64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::system_clock::now().time_since_epoch()
        ).count()
      );
    NSDictionary *segmentMeta = @{
      @"__segmentReason": @"endpoint",
      @"__segmentSource": @"segmentation_engine",
      @"__segmentCreatedAtMs": @(createdAtMs),
    };
    std::string err;
    if (!txt_live_commit_segment(
          outputEntry_,
          result.text,
          result.tokens,
          result.timestamps,
          "stt_stream",
          segmentMeta,
          &err
        )) {
      throw std::runtime_error("Failed to commit flushed text segment: " + err);
    }

    {
      std::lock_guard<std::mutex> sLock(statusMtx_);
      unitsWritten_ += (int64_t)result.text.size();
    }

    if (!txt_live_write_partial(outputEntry_, "", &err)) {
      throw std::runtime_error("Failed to clear partial text after flush: " + err);
    }
  }
}

void SttPipelineWorker::processCommands() {
  std::lock_guard<std::mutex> lock(cmdMtx_);
  while (!commandQueue_.empty()) {
    auto &cmd = commandQueue_.front();
    switch (cmd.type) {
      case PipelineCommand::Flush: {
        try {
          // Do not call inputFinished — more audio may still arrive.
          autoFlushAndCommit(false);
          cmd.completion.set_value();
        } catch (...) {
          cmd.completion.set_exception(std::current_exception());
        }
        break;
      }
      case PipelineCommand::Reset: {
        try {
          wrapper_->resetStream(streamId_);
          std::string err;
          if (!txt_live_write_partial(outputEntry_, "", &err)) {
            throw std::runtime_error("Failed to clear partial text during reset: " + err);
          }
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

void SttPipelineWorker::drainRemainingCommands() {
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

void SttPipelineWorker::joinThread() {
  if (workerThread_.joinable()) {
    workerThread_.join();
  }
}

void SttPipelineWorker::stop() {
  std::call_once(stopOnce_, [this]() {
    running.store(false);
    cv_.notify_one();
    joinThread();
  });
}

std::future<void> SttPipelineWorker::flush() {
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

std::future<void> SttPipelineWorker::reset() {
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

StreamingPipelineStatus SttPipelineWorker::getStatus() {
  std::lock_guard<std::mutex> sLock(statusMtx_);
  return StreamingPipelineStatus{
    running.load(),
    chunksProcessed_,
    unitsRead_,
    unitsWritten_,
    error_
  };
}

void SttPipelineWorker::release() {
  stop();
}
