#import "../../SherpaOnnx.h"
#import <React/RCTLog.h>

#include "../../audio/pipeline/PaLiveEntry.h"
#include "../../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "../../pipeline/bridge/SherpaOnnx+StreamingPipelineCompletion.h"
#include "../../pipeline/core/SherpaOnnx+StreamingPipeline.h"
#include "../../textbuffer/core/SherpaOnnx+TextBufferGlobals.h"
#include "../native/sherpa-onnx-kws-wrapper.h"
#include "../pipeline/KwsStreamingPipelineWorker.h"

#include <algorithm>
#include <chrono>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>

namespace {

std::unordered_map<std::string, std::unique_ptr<sherpaonnx::KwsWrapper>>
    g_kws_instances;
std::unordered_map<std::string, std::string> g_kws_instance_to_pipeline;
std::mutex g_kws_mutex;

bool ReadRequiredPath(
    NSString *value,
    const char *name,
    std::string &output,
    RCTPromiseRejectBlock reject) {
  if (value == nil || [value length] == 0) {
    reject(@"KWS_INIT_FAILED",
           [NSString stringWithFormat:@"%s path is required", name], nil);
    return false;
  }
  output = [value UTF8String];
  return true;
}

sherpaonnx::KwsWrapper *GetKwsInstance(NSString *instanceId) {
  if (instanceId == nil || [instanceId length] == 0) {
    return nullptr;
  }
  const std::string key = [instanceId UTF8String];
  std::lock_guard<std::mutex> lock(g_kws_mutex);
  auto it = g_kws_instances.find(key);
  return (it != g_kws_instances.end() && it->second != nullptr)
      ? it->second.get()
      : nullptr;
}

}  // namespace

@implementation SherpaOnnx (KeywordSpotting)

- (void)initializeKeywordSpotting:(NSString *)instanceId
                          options:(JS::NativeSherpaOnnx::KeywordSpottingInitBridgeOptions &)options
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"KWS_INIT_FAILED", @"instanceId is required", nil);
    return;
  }

  std::string encoder;
  std::string decoder;
  std::string joiner;
  std::string tokens;
  std::string keywords;
  if (!ReadRequiredPath(options.encoder(), "encoder", encoder, reject) ||
      !ReadRequiredPath(options.decoder(), "decoder", decoder, reject) ||
      !ReadRequiredPath(options.joiner(), "joiner", joiner, reject) ||
      !ReadRequiredPath(options.tokens(), "tokens", tokens, reject) ||
      !ReadRequiredPath(options.keywords(), "keywords", keywords, reject)) {
    return;
  }

  const std::string key = [instanceId UTF8String];
  const auto keywordsScore = options.keywordsScore();
  const auto keywordsThreshold = options.keywordsThreshold();
  const auto numTrailingBlanks = options.numTrailingBlanks();
  const auto maxActivePaths = options.maxActivePaths();
  const auto numThreads = options.numThreads();
  const auto debug = options.debug();
  NSString *providerValue = options.provider();
  const std::string provider =
      providerValue != nil && [providerValue length] > 0
          ? std::string([providerValue UTF8String])
          : "cpu";

  try {
    std::lock_guard<std::mutex> lock(g_kws_mutex);
    if (g_kws_instances.find(key) != g_kws_instances.end()) {
      reject(@"KWS_INIT_FAILED",
             [NSString stringWithFormat:
                 @"Keyword spotting instance already exists: %@", instanceId],
             nil);
      return;
    }

    auto wrapper = std::make_unique<sherpaonnx::KwsWrapper>();
    const auto result = wrapper->initialize(
        encoder,
        decoder,
        joiner,
        tokens,
        keywords,
        keywordsScore.has_value() ? (float)keywordsScore.value() : 1.5f,
        keywordsThreshold.has_value() ? (float)keywordsThreshold.value() : 0.25f,
        numTrailingBlanks.has_value()
            ? (int32_t)numTrailingBlanks.value() : 2,
        maxActivePaths.has_value() ? (int32_t)maxActivePaths.value() : 4,
        numThreads.has_value()
            ? std::max<int32_t>(1, (int32_t)numThreads.value()) : 1,
        provider,
        debug.has_value() && debug.value());
    if (!result.success) {
      reject(@"KWS_INIT_FAILED",
             [NSString stringWithUTF8String:result.error.c_str()], nil);
      return;
    }

    g_kws_instances.emplace(key, std::move(wrapper));
    RCTLogInfo(@"[SherpaOnnx:kws] initialized instanceId=%@", instanceId);
    resolve(@{@"success" : @YES});
  } catch (const std::exception &e) {
    reject(@"KWS_INIT_FAILED", [NSString stringWithUTF8String:e.what()], nil);
  } catch (...) {
    reject(@"KWS_INIT_FAILED", @"Unknown keyword spotting init error", nil);
  }
}

- (void)startKeywordSpottingPipeline:(NSString *)instanceId
                 audioInLiveBufferId:(NSString *)audioInLiveBufferId
                textOutLiveBufferId:(NSString *)textOutLiveBufferId
                           chunkSize:(NSNumber *)chunkSize
                            keywords:(NSString *)keywords
                             resolve:(RCTPromiseResolveBlock)resolve
                              reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"KWS_PIPELINE_INSTANCE_NOT_FOUND",
           @"Keyword spotting instance not found", nil);
    return;
  }
  if (audioInLiveBufferId == nil || [audioInLiveBufferId length] == 0) {
    reject(@"KWS_PIPELINE_AUDIO_BUFFER_NOT_FOUND",
           @"Input live audio buffer id is required", nil);
    return;
  }
  if (textOutLiveBufferId == nil || [textOutLiveBufferId length] == 0) {
    reject(@"KWS_PIPELINE_TEXT_BUFFER_NOT_FOUND",
           @"Output live text buffer id is required", nil);
    return;
  }

  const std::string instanceKey = [instanceId UTF8String];
  const std::string inputBufferKey = [audioInLiveBufferId UTF8String];
  const std::string outputBufferKey = [textOutLiveBufferId UTF8String];

  sherpaonnx::KwsWrapper *wrapper = GetKwsInstance(instanceId);
  if (!wrapper) {
    reject(@"KWS_PIPELINE_INSTANCE_NOT_FOUND",
           @"Keyword spotting instance not found", nil);
    return;
  }

  std::string existingPipelineId;
  {
    std::lock_guard<std::mutex> lock(g_kws_mutex);
    auto pit = g_kws_instance_to_pipeline.find(instanceKey);
    if (pit != g_kws_instance_to_pipeline.end()) {
      existingPipelineId = pit->second;
    }
  }

  if (!existingPipelineId.empty()) {
    std::shared_ptr<StreamingPipelineWorker> staleWorker;
    {
      std::lock_guard<std::mutex> lock(g_streaming_pipeline_mutex);
      auto it = g_streaming_pipelines.find(existingPipelineId);
      if (it != g_streaming_pipelines.end()) {
        if (it->second && it->second->isRunning()) {
          reject(@"KWS_PIPELINE_ALREADY_RUNNING",
                 [NSString stringWithFormat:
                     @"Keyword spotting pipeline already running for instance %@",
                     instanceId],
                 nil);
          return;
        }
        staleWorker = it->second;
        g_streaming_pipelines.erase(it);
      }
    }
    if (staleWorker) {
      staleWorker->release();
    }
    std::lock_guard<std::mutex> lock(g_kws_mutex);
    g_kws_instance_to_pipeline.erase(instanceKey);
  }

  std::shared_ptr<PaLiveEntry> inputEntry;
  {
    std::lock_guard<std::mutex> lock(g_pa_mutex);
    auto it = g_pa_live.find(inputBufferKey);
    if (it == g_pa_live.end() || it->second == nullptr) {
      if (g_pa_invalidated_live_ids.find(inputBufferKey) !=
          g_pa_invalidated_live_ids.end()) {
        reject(@"BUFFER_INVALIDATED",
               [NSString stringWithFormat:
                   @"Input live audio buffer is invalidated after transfer: %@",
                   audioInLiveBufferId],
               nil);
      } else {
        reject(@"KWS_PIPELINE_AUDIO_BUFFER_NOT_FOUND",
               [NSString stringWithFormat:
                   @"Input live audio buffer not found: %@",
                   audioInLiveBufferId],
               nil);
      }
      return;
    }
    inputEntry = it->second;
  }

  auto outputEntry = txt_get_live_entry(outputBufferKey);
  if (!outputEntry) {
    reject(@"KWS_PIPELINE_TEXT_BUFFER_NOT_FOUND",
           [NSString stringWithFormat:
               @"Output live text buffer not found: %@", textOutLiveBufferId],
           nil);
    return;
  }

  if (inputBufferKey.rfind("live_", 0) != 0) {
    reject(@"KWS_PIPELINE_BUFFER_KIND_MISMATCH",
           @"Input buffer must be a live audio buffer", nil);
    return;
  }
  if (inputEntry->state != PaLiveEntry::RECORDING) {
    reject(@"KWS_PIPELINE_BUFFER_NOT_RECORDING",
           @"Input audio buffer is not in recording state", nil);
    return;
  }
  if (!txt_live_is_recording(outputEntry)) {
    reject(@"KWS_PIPELINE_BUFFER_NOT_RECORDING",
           @"Output text buffer is not in recording state", nil);
    return;
  }

  const int expectedSampleRate = wrapper->getSampleRate();
  if (inputEntry->sampleRate != expectedSampleRate) {
    reject(@"KWS_PIPELINE_SAMPLE_RATE_MISMATCH",
           [NSString stringWithFormat:
               @"Input buffer sample rate (%d) does not match spotter sample rate (%d)",
               inputEntry->sampleRate,
               expectedSampleRate],
           nil);
    return;
  }

  int safeChunkSize = 1600;
  if (chunkSize != nil && [chunkSize intValue] > 0) {
    safeChunkSize = [chunkSize intValue];
  }

  const std::string keywordsOverride =
      keywords != nil ? std::string([keywords UTF8String]) : "";
  const std::string streamId =
      std::string("kws_pipeline_stream_") +
      std::to_string(
          std::chrono::steady_clock::now().time_since_epoch().count());

  if (!wrapper->createStream(streamId, keywordsOverride)) {
    reject(@"STREAMING_PIPELINE_ERROR",
           @"Failed to create keyword spotting pipeline stream", nil);
    return;
  }

  try {
    auto worker = std::make_shared<KwsStreamingPipelineWorker>(
        wrapper, streamId, inputEntry, outputEntry, safeChunkSize);

    {
      std::lock_guard<std::mutex> lock(g_streaming_pipeline_mutex);
      g_streaming_pipelines[worker->pipelineId] = worker;
    }
    worker->start();
    so_start_streaming_pipeline_completion_watcher(
        self, worker->pipelineId, worker);

    {
      std::lock_guard<std::mutex> lock(g_kws_mutex);
      g_kws_instance_to_pipeline[instanceKey] = worker->pipelineId;
    }

    // Mirror Android: clear instance→pipeline when the worker finishes naturally
    // (completion watcher only removes the registry entry, not this map).
    const std::string pipelineIdCopy = worker->pipelineId;
    std::thread([instanceKey, pipelineIdCopy, worker]() {
      using namespace std::chrono_literals;
      while (worker->isRunning()) {
        std::this_thread::sleep_for(20ms);
      }
      std::lock_guard<std::mutex> lock(g_kws_mutex);
      auto it = g_kws_instance_to_pipeline.find(instanceKey);
      if (it != g_kws_instance_to_pipeline.end() &&
          it->second == pipelineIdCopy) {
        g_kws_instance_to_pipeline.erase(it);
      }
    }).detach();

    RCTLogInfo(@"[SherpaOnnx:kws] pipeline start instanceId=%@ pipelineId=%@",
               instanceId,
               [NSString stringWithUTF8String:worker->pipelineId.c_str()]);
    resolve(@{
      @"pipelineId" :
          [NSString stringWithUTF8String:worker->pipelineId.c_str()]
    });
  } catch (const std::exception &e) {
    wrapper->releaseStream(streamId);
    reject(@"STREAMING_PIPELINE_ERROR",
           [NSString stringWithUTF8String:e.what()], nil);
  } catch (...) {
    wrapper->releaseStream(streamId);
    reject(@"STREAMING_PIPELINE_ERROR",
           @"Failed to start keyword spotting pipeline", nil);
  }
}

- (void)unloadKeywordSpotting:(NSString *)instanceId
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    resolve(nil);
    return;
  }

  try {
    const std::string key = [instanceId UTF8String];
    std::string pipelineId;
    {
      std::lock_guard<std::mutex> lock(g_kws_mutex);
      auto pit = g_kws_instance_to_pipeline.find(key);
      if (pit != g_kws_instance_to_pipeline.end()) {
        pipelineId = pit->second;
      }
    }

    if (!pipelineId.empty()) {
      std::shared_ptr<StreamingPipelineWorker> worker;
      {
        std::lock_guard<std::mutex> lock(g_streaming_pipeline_mutex);
        auto wit = g_streaming_pipelines.find(pipelineId);
        if (wit != g_streaming_pipelines.end()) {
          worker = wit->second;
          g_streaming_pipelines.erase(wit);
        }
      }
      if (worker) {
        worker->stop();
      }
    }

    std::lock_guard<std::mutex> lock(g_kws_mutex);
    auto it = g_kws_instances.find(key);
    if (it != g_kws_instances.end()) {
      it->second->unload();
      g_kws_instances.erase(it);
    }
    g_kws_instance_to_pipeline.erase(key);
    RCTLogInfo(@"[SherpaOnnx:kws] unloaded instanceId=%@", instanceId);
    resolve(nil);
  } catch (const std::exception &e) {
    reject(@"KWS_INTERNAL_ERROR", [NSString stringWithUTF8String:e.what()], nil);
  } catch (...) {
    reject(@"KWS_INTERNAL_ERROR", @"Unknown keyword spotting unload error", nil);
  }
}

@end
