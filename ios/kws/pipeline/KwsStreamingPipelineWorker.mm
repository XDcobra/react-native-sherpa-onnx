#include "KwsStreamingPipelineWorker.h"

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

NSString *NsUtf8(const std::string &s) {
  NSString *n = [NSString stringWithUTF8String:s.c_str()];
  return n ?: @"";
}
}  // namespace

KwsStreamingPipelineWorker::KwsStreamingPipelineWorker(
    sherpaonnx::KwsWrapper *wrapper,
    const std::string &streamId,
    std::shared_ptr<PaLiveEntry> inputEntry,
    std::shared_ptr<TxtLiveEntry> outputEntry,
    int chunkSize)
    : wrapper_(wrapper),
      streamId_(streamId),
      inputEntry_(std::move(inputEntry)),
      outputEntry_(std::move(outputEntry)),
      chunkSize_(std::max(1, chunkSize)) {
  pipelineId = std::string("kws_") +
      std::to_string(
          std::chrono::steady_clock::now().time_since_epoch().count());
}

KwsStreamingPipelineWorker::~KwsStreamingPipelineWorker() {
  release();
}

void KwsStreamingPipelineWorker::start() {
  running.store(true);
  cursorId_ = inputEntry_->createCursorHandle();
  appendListenerToken_ = inputEntry_->addAppendListener([this]() {
    cv_.notify_one();
  });
  NSLog(@"[SherpaOnnx:kws] worker start pipelineId=%@ chunkSize=%d",
        NsUtf8(pipelineId),
        chunkSize_);
  workerThread_ = std::thread([this]() { runLoop(); });
}

void KwsStreamingPipelineWorker::runLoop() {
  try {
    if (!wrapper_) {
      throw std::runtime_error("KWS wrapper is null");
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

      wrapper_->acceptWaveform(
          streamId_, sampleRate, chunk.data(), chunk.size());
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

      maybeCommitHit(wrapper_->getResult(streamId_));
    }
  } catch (const std::exception &e) {
    std::lock_guard<std::mutex> sLock(statusMtx_);
    error_ = e.what();
  } catch (...) {
    std::lock_guard<std::mutex> sLock(statusMtx_);
    error_ = "Unknown error in KWS pipeline";
  }

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

  {
    std::lock_guard<std::mutex> lock(cmdMtx_);
    while (!commandQueue_.empty()) {
      auto &cmd = commandQueue_.front();
      try {
        cmd.completion.set_value();
      } catch (...) {
      }
      commandQueue_.pop_front();
    }
    running.store(false);
  }

  NSLog(@"[SherpaOnnx:kws] worker end pipelineId=%@ hits=%d",
        NsUtf8(pipelineId),
        hitCount_);
}

void KwsStreamingPipelineWorker::maybeCommitHit(
    const sherpaonnx::KwsStreamResult &result) {
  const std::string keyword = TrimCopy(result.keyword);
  if (keyword.empty()) {
    return;
  }

  hitCount_++;
  const int64_t createdAtMs = static_cast<int64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::system_clock::now().time_since_epoch())
          .count());
  NSDictionary *segmentMeta = @{
    @"__segmentReason" : @"endpoint",
    @"__segmentSource" : @"kws_stream",
    @"__segmentCreatedAtMs" : @(createdAtMs),
    // Public meta (survives JS toPublicTextMeta) so onKeyword can filter kws_stream.
    @"source" : @"kws_stream",
    @"keyword" : NsUtf8(keyword),
    @"startTime" : @(result.startTime),
  };
  std::string err;
  if (!txt_live_commit_segment(
          outputEntry_,
          keyword,
          result.tokens,
          result.timestamps,
          "kws_stream",
          segmentMeta,
          &err)) {
    throw std::runtime_error("Failed to commit keyword segment: " + err);
  }
  {
    std::lock_guard<std::mutex> sLock(statusMtx_);
    unitsWritten_ += (int64_t)keyword.size();
  }
  NSLog(@"[SherpaOnnx:kws] hit pipelineId=%@ keyword=%@",
        NsUtf8(pipelineId),
        NsUtf8(keyword));
  wrapper_->resetStream(streamId_);
}

void KwsStreamingPipelineWorker::autoFlushAndCommit(bool endOfAudio) {
  if (endOfAudio && wrapper_) {
    wrapper_->inputFinished(streamId_);
  }
  while (wrapper_->isReady(streamId_)) {
    wrapper_->decode(streamId_);
  }
  maybeCommitHit(wrapper_->getResult(streamId_));
}

void KwsStreamingPipelineWorker::processCommands() {
  std::lock_guard<std::mutex> lock(cmdMtx_);
  while (!commandQueue_.empty()) {
    auto &cmd = commandQueue_.front();
    switch (cmd.type) {
      case PipelineCommand::Flush: {
        try {
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

void KwsStreamingPipelineWorker::drainRemainingCommands() {
  std::lock_guard<std::mutex> lock(cmdMtx_);
  while (!commandQueue_.empty()) {
    auto &cmd = commandQueue_.front();
    try {
      cmd.completion.set_value();
    } catch (...) {
    }
    commandQueue_.pop_front();
  }
}

void KwsStreamingPipelineWorker::joinThread() {
  if (workerThread_.joinable()) {
    workerThread_.join();
  }
}

void KwsStreamingPipelineWorker::stop() {
  std::call_once(stopOnce_, [this]() {
    running.store(false);
    cv_.notify_one();
    joinThread();
  });
}

std::future<void> KwsStreamingPipelineWorker::flush() {
  PipelineCommand cmd;
  cmd.type = PipelineCommand::Flush;
  auto future = cmd.completion.get_future();
  {
    std::lock_guard<std::mutex> lock(cmdMtx_);
    if (!running.load()) {
      try {
        cmd.completion.set_value();
      } catch (...) {
      }
      return future;
    }
    commandQueue_.push_back(std::move(cmd));
  }
  cv_.notify_one();
  return future;
}

std::future<void> KwsStreamingPipelineWorker::reset() {
  PipelineCommand cmd;
  cmd.type = PipelineCommand::Reset;
  auto future = cmd.completion.get_future();
  {
    std::lock_guard<std::mutex> lock(cmdMtx_);
    if (!running.load()) {
      try {
        cmd.completion.set_value();
      } catch (...) {
      }
      return future;
    }
    commandQueue_.push_back(std::move(cmd));
  }
  cv_.notify_one();
  return future;
}

StreamingPipelineStatus KwsStreamingPipelineWorker::getStatus() {
  std::lock_guard<std::mutex> sLock(statusMtx_);
  return StreamingPipelineStatus{
      running.load(),
      chunksProcessed_,
      unitsRead_,
      unitsWritten_,
      error_};
}

void KwsStreamingPipelineWorker::release() {
  stop();
}
