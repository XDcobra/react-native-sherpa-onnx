#import "../../SherpaOnnx.h"

#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-model-path-fill.h"
#include "sherpa-onnx-validate-punctuation.h"
#include "sherpa-onnx/c-api/cxx-api.h"
#include "../../pipeline/core/SherpaOnnx+StreamingPipeline.h"
#include "../../pipeline/bridge/SherpaOnnx+StreamingPipelineCompletion.h"
#include "../../textbuffer/core/SherpaOnnx+TextBufferGlobals.h"
#include "../../punctuation/core/PunctuationTextInputNormalization.hpp"

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

static void FillPunctuationModelPathsFromDict(
    NSDictionary *dict,
    sherpaonnx::PunctuationModelPaths &paths) {
  if (![dict isKindOfClass:[NSDictionary class]]) {
    return;
  }
  std::map<std::string, std::string> pathMap;
  for (NSString *key in dict) {
    id value = dict[key];
    if ([value isKindOfClass:[NSString class]] && [(NSString *)value length] > 0) {
      pathMap[std::string([key UTF8String])] = std::string([(NSString *)value UTF8String]);
    }
  }
  sherpaonnx::FillPunctuationModelPathsFromStringMap(pathMap, paths);
}

struct PunctuationInitScalars {
  int32_t numThreads = 1;
  bool debug = false;
  std::string provider = "cpu";
};

static PunctuationInitScalars ParsePunctuationInitScalars(NSDictionary *options) {
  PunctuationInitScalars scalars;
  if ([options[@"numThreads"] respondsToSelector:@selector(intValue)]) {
    scalars.numThreads = MAX(1, [options[@"numThreads"] intValue]);
  }
  if ([options[@"debug"] respondsToSelector:@selector(boolValue)]) {
    scalars.debug = [options[@"debug"] boolValue];
  }
  NSString *provider = options[@"provider"];
  if (provider != nil && provider.length > 0) {
    scalars.provider = std::string([provider UTF8String]);
  }
  return scalars;
}

static std::string punct_resolve_text_input_normalization(NSString *mode) {
  if (mode == nil || mode.length == 0) {
    return "lower";
  }
  std::string resolved = mode.UTF8String ?: "lower";
  if (resolved == "none") {
    return "none";
  }
  return "lower";
}

static std::string punct_normalize_input_text(
    const std::string &text,
    const std::string &mode) {
  if (mode == "none" || text.empty()) {
    return text;
  }
  NSString *ns = [[NSString alloc] initWithBytes:text.data()
                                          length:text.size()
                                        encoding:NSUTF8StringEncoding];
  if (ns == nil) {
    return text;
  }
  NSString *lower = [ns lowercaseString];
  if (lower == nil) {
    return text;
  }
  return std::string(lower.UTF8String ?: "");
}

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
      std::shared_ptr<TxtLiveEntry> output,
      std::string textInputNormalization)
      : engine_(std::move(engine)),
        input_(std::move(input)),
        output_(std::move(output)),
        textInputNormalization_(std::move(textInputNormalization)) {
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
          if (input_->state == TxtLiveEntry::FINISHED) {
            if (postFinishFlushCompleted_) break;
            std::unique_lock<std::mutex> lock(mutex_);
            cv_.wait_for(lock, std::chrono::milliseconds(50));
            continue;
          }
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
    const std::string normalized =
        punct_normalize_input_text(segment.text, textInputNormalization_);
    unitsRead_ += (int64_t)normalized.size();
    std::string outText = engine_->AddPunctuation(normalized);
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
          if (input_->state == TxtLiveEntry::FINISHED) {
            postFinishFlushCompleted_ = true;
          }
        } else {
          while (!input_->drainSegments(cursorId_, 100).empty()) {}
          postFinishFlushCompleted_ = false;
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
  std::string textInputNormalization_;
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
  /// After input is FINISHED, runLoop exits only once a Flush has completed
  /// while the input is still finished (single worker thread).
  bool postFinishFlushCompleted_ = false;
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
    const std::string normalized =
        punct_text_input_normalization::normalize(text, "lower");
    *outText = engine->AddPunctuation(normalized);
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
                           options:(NSDictionary *)options
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || instanceId.length == 0) {
    reject(kInitErr, @"instanceId is required", nil);
    return;
  }
  if (options == nil) {
    reject(kInitErr, @"options is required", nil);
    return;
  }

  NSString *initMode = options[@"initMode"];
  if (initMode == nil || initMode.length == 0) {
    initMode = @"auto";
  }
  const bool isCustomInit = [initMode isEqualToString:@"custom"];
  const PunctuationInitScalars scalars = ParsePunctuationInitScalars(options);

  @try {
    std::string cnnPath;
    std::string vocabPath;
    NSMutableArray *models = [NSMutableArray array];

    if (isCustomInit) {
      NSString *modelType = options[@"modelType"];
      if (modelType == nil || modelType.length == 0 || [modelType isEqualToString:@"auto"]) {
        reject(kInitErr, @"modelType is required for initMode custom", nil);
        return;
      }
      NSString *req = [[modelType stringByTrimmingCharactersInSet:
          [NSCharacterSet whitespaceAndNewlineCharacterSet]] lowercaseString];
      if (![req isEqualToString:@"cnn_bilstm"]) {
        reject(kInitErr, @"Streaming punctuation requires cnn_bilstm", nil);
        return;
      }
      id pathsRaw = options[@"modelPaths"];
      NSDictionary *pathsDict =
          [pathsRaw isKindOfClass:[NSDictionary class]] ? (NSDictionary *)pathsRaw : nil;
      if (pathsDict == nil || pathsDict.count == 0) {
        reject(kInitErr, @"modelPaths is required for initMode custom", nil);
        return;
      }

      sherpaonnx::PunctuationModelPaths paths;
      FillPunctuationModelPathsFromDict(pathsDict, paths);
      auto validation = sherpaonnx::ValidatePunctuationPaths(
          sherpaonnx::PunctuationModelKind::kCnnBilstm,
          paths,
          "custom");
      if (!validation.ok) {
        NSString *msg = validation.error.empty()
            ? @"Punctuation: custom path validation failed"
            : [NSString stringWithUTF8String:validation.error.c_str()];
        reject(kInitErr, msg, nil);
        return;
      }
      cnnPath = paths.cnn_bilstm;
      vocabPath = paths.bpe_vocab;
      [models addObject:@{@"type": @"cnn_bilstm", @"modelDir": @"custom"}];
    } else {
      NSString *modelDir = options[@"modelDir"];
      if (modelDir == nil || modelDir.length == 0) {
        reject(kInitErr, @"modelDir is required for initMode auto", nil);
        return;
      }
      NSString *modelType = options[@"modelType"];
      NSString *req = modelType == nil ? @"auto" : [[modelType stringByTrimmingCharactersInSet:
          [NSCharacterSet whitespaceAndNewlineCharacterSet]] lowercaseString];
      if (!([req isEqualToString:@"auto"] || [req isEqualToString:@"cnn_bilstm"])) {
        reject(kInitErr, @"Streaming punctuation requires cnn_bilstm or auto", nil);
        return;
      }

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
      cnnPath = det.paths.cnn_bilstm;
      vocabPath = det.paths.bpe_vocab;
      for (const auto &m : det.detectedModels) {
        [models addObject:@{
          @"type": [NSString stringWithUTF8String:m.type.c_str()] ?: @"",
          @"modelDir": [NSString stringWithUTF8String:m.modelDir.c_str()] ?: @""
        }];
      }
      (void)idStr;
    }

    if (cnnPath.empty() || vocabPath.empty()) {
      reject(kInitErr, @"Punctuation: missing cnn_bilstm or bpe.vocab path", nil);
      return;
    }

    std::string idStr = instanceId.UTF8String ?: "";
    sherpa_onnx::cxx::OnlinePunctuationConfig cfg;
    cfg.model.cnn_bilstm = cnnPath;
    cfg.model.bpe_vocab = vocabPath;
    cfg.model.num_threads = scalars.numThreads;
    cfg.model.debug = scalars.debug;
    cfg.model.provider = scalars.provider;
    auto created = sherpa_onnx::cxx::OnlinePunctuation::Create(cfg);
    auto ptr = std::make_shared<sherpa_onnx::cxx::OnlinePunctuation>(std::move(created));
    {
      std::lock_guard<std::mutex> lock(g_punct_online_mutex);
      g_punct_online[idStr] = ptr;
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
               textInputNormalization:(NSString *)textInputNormalization
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
  const std::string mode = punct_resolve_text_input_normalization(textInputNormalization);
  const std::string normalized =
      punct_normalize_input_text(text.UTF8String ?: "", mode);
  CFTimeInterval t0 = CFAbsoluteTimeGetCurrent();
  std::string outText = engine->AddPunctuation(normalized);
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
               textInputNormalization:(NSString *)textInputNormalization
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

  const std::string normalization =
      punct_resolve_text_input_normalization(textInputNormalization);
  auto worker = std::make_shared<PunctuationPipelineWorker>(
      engine, input, output, normalization);
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
