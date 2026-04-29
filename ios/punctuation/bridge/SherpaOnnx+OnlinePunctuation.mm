#import "../../SherpaOnnx.h"

#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx/c-api/cxx-api.h"
#include "../../pipeline/core/SherpaOnnx+StreamingPipeline.h"
#include "../../pipeline/bridge/SherpaOnnx+StreamingPipelineCompletion.h"
#include "../../textbuffer/core/SherpaOnnx+TextBufferGlobals.h"

#include <CoreFoundation/CoreFoundation.h>
#include <condition_variable>
#include <deque>
#include <future>
#include <map>
#include <memory>
#include <mutex>
#include <random>
#include <sstream>
#include <string>
#include <thread>

namespace {

std::mutex g_punct_online_mutex;
std::map<std::string, std::shared_ptr<sherpa_onnx::cxx::OnlinePunctuation>> g_punct_online;

static NSString *kInitErr = @"PUNCTUATION_INIT_ERROR";
static NSString *kPunctErr = @"PUNCTUATION_ERROR";
static NSString *kNotFound = @"PUNCTUATION_INSTANCE_NOT_FOUND";
static NSString *kTxtKind = @"TEXT_BUFFER_KIND_MISMATCH";
static NSString *kTxtState = @"TEXT_INVALID_STATE";

std::string punct_uuid() {
  static const char *kHex = "0123456789abcdef";
  std::random_device rd;
  std::mt19937 gen(rd());
  std::uniform_int_distribution<int> dis(0, 15);
  std::stringstream ss;
  int groups[] = {8, 4, 4, 4, 12};
  for (size_t g = 0; g < 5; ++g) {
    if (g > 0) ss << "-";
    for (int i = 0; i < groups[g]; ++i) ss << kHex[dis(gen)];
  }
  return ss.str();
}

class PunctuationPipelineWorker final : public StreamingPipelineWorker {
 public:
  PunctuationPipelineWorker(
      std::shared_ptr<sherpa_onnx::cxx::OnlinePunctuation> engine,
      std::shared_ptr<TxtLiveEntry> input,
      std::shared_ptr<TxtLiveEntry> output)
      : engine_(std::move(engine)),
        input_(std::move(input)),
        output_(std::move(output)) {
    pipelineId = "punct_pipeline_" + punct_uuid();
  }

  ~PunctuationPipelineWorker() override { release(); }

  void start() override {
    running.store(true);
    cursorId_ = input_->createSegmentCursor();
    appendListenerToken_ = input_->addAppendListener([this]() {
      {
        std::lock_guard<std::mutex> lock(mutex_);
      }
      cv_.notify_one();
    });
    thread_ = std::thread([this]() { runLoop(); });
  }

  void stop() override {
    if (!running.exchange(false)) return;
    cv_.notify_all();
    if (thread_.joinable()) {
      thread_.join();
    }
  }

  std::future<void> flush() override {
    auto cmd = std::make_shared<Command>();
    cmd->type = CommandType::Flush;
    auto fut = cmd->promise.get_future();
    {
      std::lock_guard<std::mutex> lock(mutex_);
      commands_.push_back(cmd);
    }
    cv_.notify_one();
    return fut;
  }

  std::future<void> reset() override {
    auto cmd = std::make_shared<Command>();
    cmd->type = CommandType::Reset;
    auto fut = cmd->promise.get_future();
    {
      std::lock_guard<std::mutex> lock(mutex_);
      commands_.push_back(cmd);
    }
    cv_.notify_one();
    return fut;
  }

  StreamingPipelineStatus getStatus() override {
    StreamingPipelineStatus status;
    status.isRunning = running.load();
    status.chunksProcessed = chunksProcessed_;
    status.unitsRead = unitsRead_;
    status.unitsWritten = unitsWritten_;
    status.error = error_;
    return status;
  }

  void release() override {
    stop();
    if (cursorId_ >= 0 && input_) {
      input_->releaseSegmentCursor(cursorId_);
      cursorId_ = -1;
    }
    if (appendListenerToken_ >= 0 && input_) {
      input_->removeAppendListener(appendListenerToken_);
      appendListenerToken_ = -1;
    }
  }

 private:
  enum class CommandType { Flush, Reset };
  struct Command {
    CommandType type;
    std::promise<void> promise;
  };

  void runLoop() {
    try {
      while (running.load()) {
        processCommands();
        auto segments = input_->drainSegments(cursorId_, 1);
        if (segments.empty()) {
          if (input_->state == TxtLiveEntry::FINISHED) break;
          std::unique_lock<std::mutex> lock(mutex_);
          cv_.wait_for(lock, std::chrono::milliseconds(50));
          continue;
        }
        if (!segments[0].text.empty()) {
          punctuateSegment(segments[0]);
          chunksProcessed_++;
        }
      }
    } catch (const std::exception &e) {
      error_ = e.what();
    } catch (...) {
      error_ = "Unknown error in punctuation pipeline";
    }
    running.store(false);
    failPendingCommands();
  }

  void punctuateSegment(const TextSegment &segment) {
    unitsRead_ += (int64_t)segment.text.size();
    std::string outText = engine_->AddPunctuation(segment.text);
    NSMutableDictionary *meta = [NSMutableDictionary dictionaryWithDictionary:@{
      @"__segmentReason": @"punctuation",
      @"__segmentSource": @"segmentation_engine",
      @"__segmentCreatedAtMs": @((double)std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count()),
    }];
    if (segment.meta != nil) {
      [meta addEntriesFromDictionary:segment.meta];
    }
    output_->commitSegment(outText, {}, {}, "punctuation_stream", meta);
    unitsWritten_ += (int64_t)outText.size();
  }

  void processCommands() {
    while (true) {
      std::shared_ptr<Command> cmd;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        if (commands_.empty()) return;
        cmd = commands_.front();
        commands_.pop_front();
      }
      try {
        if (cmd->type == CommandType::Flush) {
          while (true) {
            auto remaining = input_->drainSegments(cursorId_, 1);
            if (remaining.empty()) break;
            if (!remaining[0].text.empty()) {
              punctuateSegment(remaining[0]);
              chunksProcessed_++;
            }
          }
        } else {
          while (!input_->drainSegments(cursorId_, 100).empty()) {}
        }
        cmd->promise.set_value();
      } catch (...) {
        cmd->promise.set_exception(std::current_exception());
      }
    }
  }

  void failPendingCommands() {
    std::deque<std::shared_ptr<Command>> pending;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      pending.swap(commands_);
    }
    for (auto &cmd : pending) {
      cmd->promise.set_exception(std::make_exception_ptr(
          std::runtime_error("Pipeline stopped before command completed")));
    }
  }

  std::shared_ptr<sherpa_onnx::cxx::OnlinePunctuation> engine_;
  std::shared_ptr<TxtLiveEntry> input_;
  std::shared_ptr<TxtLiveEntry> output_;
  std::thread thread_;
  int cursorId_ = -1;
  int appendListenerToken_ = -1;
  std::mutex mutex_;
  std::condition_variable cv_;
  std::deque<std::shared_ptr<Command>> commands_;
  int64_t chunksProcessed_ = 0;
  int64_t unitsRead_ = 0;
  int64_t unitsWritten_ = 0;
  std::string error_;
};

}  // namespace

extern "C" void sherpaonnx_punct_online_invalidate_all(void) {
  std::lock_guard<std::mutex> lock(g_punct_online_mutex);
  g_punct_online.clear();
}

extern "C" bool sherpaonnx_punct_online_add_punctuation_if_exists(
    const std::string &instanceId,
    const std::string &text,
    std::string *outText) {
  std::shared_ptr<sherpa_onnx::cxx::OnlinePunctuation> engine;
  {
    std::lock_guard<std::mutex> lock(g_punct_online_mutex);
    auto it = g_punct_online.find(instanceId);
    if (it == g_punct_online.end()) {
      return false;
    }
    engine = it->second;
  }
  if (outText != nullptr) {
    *outText = engine->AddPunctuation(text);
  }
  return true;
}

extern "C" bool sherpaonnx_punct_online_has_instance(
    const std::string &instanceId) {
  std::lock_guard<std::mutex> lock(g_punct_online_mutex);
  return g_punct_online.find(instanceId) != g_punct_online.end();
}

@implementation SherpaOnnx (OnlinePunctuation)

- (void)initializeOnlinePunctuation:(NSString *)instanceId
                            modelDir:(NSString *)modelDir
                           modelType:(NSString *)modelType
                          numThreads:(NSNumber *)numThreads
                            provider:(NSString *)provider
                               debug:(NSNumber *)debug
                             resolve:(RCTPromiseResolveBlock)resolve
                              reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || instanceId.length == 0) {
    reject(kInitErr, @"instanceId is required", nil);
    return;
  }
  if (modelDir == nil || modelDir.length == 0) {
    reject(kInitErr, @"modelDir is required", nil);
    return;
  }
  NSString *req = modelType == nil ? @"auto" : [[modelType stringByTrimmingCharactersInSet:
      [NSCharacterSet whitespaceAndNewlineCharacterSet]] lowercaseString];
  if (!([req isEqualToString:@"auto"] || [req isEqualToString:@"cnn_bilstm"])) {
    reject(kInitErr, @"Streaming punctuation requires cnn_bilstm or auto", nil);
    return;
  }

  @try {
    std::string idStr = instanceId.UTF8String ?: "";
    std::string dirStr = modelDir.UTF8String ?: "";
    auto det = sherpaonnx::DetectPunctuationModel(
        std::optional<std::string>(dirStr),
        std::nullopt,
        "cnn_bilstm");
    if (!det.ok || det.selectedKind != sherpaonnx::PunctuationModelKind::kCnnBilstm || !det.isStreaming) {
      NSString *msg = det.error.empty()
          ? @"Punctuation: model is not a valid online CNN-BiLSTM layout"
          : [NSString stringWithUTF8String:det.error.c_str()];
      reject(kInitErr, msg, nil);
      return;
    }
    if (det.paths.cnn_bilstm.empty() || det.paths.bpe_vocab.empty()) {
      reject(kInitErr, @"Punctuation: missing cnn_bilstm or bpe.vocab path", nil);
      return;
    }

    sherpa_onnx::cxx::OnlinePunctuationConfig cfg;
    cfg.model.cnn_bilstm = det.paths.cnn_bilstm;
    cfg.model.bpe_vocab = det.paths.bpe_vocab;
    cfg.model.num_threads = numThreads != nil ? std::max(1, numThreads.intValue) : 1;
    cfg.model.debug = debug != nil && debug.boolValue;
    cfg.model.provider = provider.length > 0 ? provider.UTF8String : "cpu";
    auto created = sherpa_onnx::cxx::OnlinePunctuation::Create(cfg);
    auto ptr = std::make_shared<sherpa_onnx::cxx::OnlinePunctuation>(std::move(created));
    {
      std::lock_guard<std::mutex> lock(g_punct_online_mutex);
      g_punct_online[idStr] = ptr;
    }

    NSMutableArray *models = [NSMutableArray array];
    for (const auto &m : det.detectedModels) {
      [models addObject:@{
        @"type": [NSString stringWithUTF8String:m.type.c_str()] ?: @"",
        @"modelDir": [NSString stringWithUTF8String:m.modelDir.c_str()] ?: @""
      }];
    }
    resolve(@{
      @"success": @YES,
      @"modelType": @"cnn_bilstm",
      @"detectedModels": models,
    });
  } @catch (NSException *exception) {
    reject(kInitErr, [NSString stringWithFormat:@"Online punctuation init: %@", exception.reason], nil);
  }
}

- (void)processOnlinePunctuationChunk:(NSString *)instanceId
                                  text:(NSString *)text
                               resolve:(RCTPromiseResolveBlock)resolve
                                reject:(RCTPromiseRejectBlock)reject
{
  std::shared_ptr<sherpa_onnx::cxx::OnlinePunctuation> engine;
  {
    std::lock_guard<std::mutex> lock(g_punct_online_mutex);
    auto it = g_punct_online.find(instanceId.UTF8String ?: "");
    if (it == g_punct_online.end()) {
      reject(kNotFound, @"Online punctuation instance not found", nil);
      return;
    }
    engine = it->second;
  }
  CFTimeInterval t0 = CFAbsoluteTimeGetCurrent();
  std::string outText = engine->AddPunctuation(text.UTF8String ?: "");
  CFTimeInterval t1 = CFAbsoluteTimeGetCurrent();
  resolve(@{
    @"punctuatedText": [NSString stringWithUTF8String:outText.c_str()] ?: @"",
    @"processingTimeMs": @((t1 - t0) * 1000.0),
  });
}

- (void)unloadOnlinePunctuation:(NSString *)instanceId
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
  std::lock_guard<std::mutex> lock(g_punct_online_mutex);
  g_punct_online.erase(instanceId.UTF8String ?: "");
  resolve(nil);
}

- (void)startStreamingPunctuationPipeline:(NSString *)instanceId
                   inputBufferId:(NSString *)inputBufferId
                  outputBufferId:(NSString *)outputBufferId
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
  std::shared_ptr<sherpa_onnx::cxx::OnlinePunctuation> engine;
  {
    std::lock_guard<std::mutex> lock(g_punct_online_mutex);
    auto it = g_punct_online.find(instanceId.UTF8String ?: "");
    if (it == g_punct_online.end()) {
      reject(kNotFound, @"Online punctuation instance not found", nil);
      return;
    }
    engine = it->second;
  }

  auto input = txt_get_live_entry(inputBufferId.UTF8String ?: "");
  auto output = txt_get_live_entry(outputBufferId.UTF8String ?: "");
  if (!input || !output) {
    reject(kTxtKind, @"Streaming punctuation requires live text input and output buffers", nil);
    return;
  }
  if (input->state != TxtLiveEntry::RECORDING || output->state != TxtLiveEntry::RECORDING) {
    reject(kTxtState, @"Streaming punctuation buffers must be recording live text buffers", nil);
    return;
  }

  auto worker = std::make_shared<PunctuationPipelineWorker>(engine, input, output);
  std::string pid = worker->pipelineId;
  {
    std::lock_guard<std::mutex> pipeLock(g_streaming_pipeline_mutex);
    g_streaming_pipelines[pid] = worker;
  }
  worker->start();
  so_start_streaming_pipeline_completion_watcher(self, pid, worker);
  resolve(@{@"pipelineId": [NSString stringWithUTF8String:pid.c_str()] ?: @""});
}

@end
