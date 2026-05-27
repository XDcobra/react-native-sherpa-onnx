/**
 * SherpaOnnx+OnlineSTT.mm
 *
 * Pipeline-only online STT bridge:
 * - initializeOnlineStt
 * - startSttPipeline (live audio -> live text)
 * - unloadOnlineStt
 */

#import "../../SherpaOnnx.h"
#import <React/RCTLog.h>

#include "../../audio/pipeline/PaLiveEntry.h"
#include "../../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "../../pipeline/bridge/SherpaOnnx+StreamingPipelineCompletion.h"
#include "../../pipeline/core/SherpaOnnx+StreamingPipeline.h"
#include "../../textbuffer/core/SherpaOnnx+TextBufferGlobals.h"
#include "../pipeline/SttPipelineWorker.h"
#include "../native/sherpa-onnx-online-stt-wrapper.h"

#include <chrono>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

static std::unordered_map<std::string, std::unique_ptr<sherpaonnx::OnlineSttWrapper>> g_online_stt_instances;
static std::unordered_map<std::string, std::string> g_online_stt_instance_to_pipeline;
static std::mutex g_online_stt_mutex;

static sherpaonnx::OnlineSttWrapper* getOnlineSttInstance(NSString* instanceId) {
    if (instanceId == nil || [instanceId length] == 0) return nullptr;
    std::string key = [instanceId UTF8String];
    std::lock_guard<std::mutex> lock(g_online_stt_mutex);
    auto it = g_online_stt_instances.find(key);
    return (it != g_online_stt_instances.end() && it->second != nullptr) ? it->second.get() : nullptr;
}

@implementation SherpaOnnx (OnlineSTT)

- (void)initializeOnlineStt:(NSString *)instanceId
                               options:(JS::NativeSherpaOnnx::SpecInitializeOnlineSttOptions &)options
                               resolve:(RCTPromiseResolveBlock)resolve
                                reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(@"STT_INIT_FAILED", @"instanceId is required", nil);
        return;
    }

    NSString *modelDir = options.modelDir();
    NSString *modelType = options.modelType();
    if (modelDir == nil || [modelDir length] == 0) {
        reject(@"STT_INIT_FAILED", @"modelDir is required", nil);
        return;
    }

    std::string instanceIdStr = [instanceId UTF8String];
    std::string modelDirStr = [modelDir UTF8String];
    std::string modelTypeStr = (modelType != nil && [modelType length] > 0) ? [modelType UTF8String] : "transducer";

    auto enableEndpoint = options.enableEndpoint();
    NSString *decodingMethod = options.decodingMethod();
    auto maxActivePaths = options.maxActivePaths();
    NSString *hotwordsFile = options.hotwordsFile();
    auto hotwordsScore = options.hotwordsScore();
    auto numThreads = options.numThreads();
    NSString *provider = options.provider();
    NSString *ruleFsts = options.ruleFsts();
    NSString *ruleFars = options.ruleFars();
    auto dither = options.dither();
    auto blankPenalty = options.blankPenalty();
    auto debug = options.debug();
    auto rule1MustContainNonSilence = options.rule1MustContainNonSilence();
    auto rule1MinTrailingSilence = options.rule1MinTrailingSilence();
    auto rule1MinUtteranceLength = options.rule1MinUtteranceLength();
    auto rule2MustContainNonSilence = options.rule2MustContainNonSilence();
    auto rule2MinTrailingSilence = options.rule2MinTrailingSilence();
    auto rule2MinUtteranceLength = options.rule2MinUtteranceLength();
    auto rule3MustContainNonSilence = options.rule3MustContainNonSilence();
    auto rule3MinTrailingSilence = options.rule3MinTrailingSilence();
    auto rule3MinUtteranceLength = options.rule3MinUtteranceLength();

    @try {
        std::lock_guard<std::mutex> lock(g_online_stt_mutex);
        if (g_online_stt_instances.find(instanceIdStr) != g_online_stt_instances.end()) {
            reject(@"STT_INIT_FAILED", @"Online STT instance already exists", nil);
            return;
        }

        auto wrapper = std::make_unique<sherpaonnx::OnlineSttWrapper>();
        sherpaonnx::OnlineSttInitResult result = wrapper->initialize(
            modelDirStr,
            modelTypeStr,
            enableEndpoint.has_value() && enableEndpoint.value(),
            decodingMethod != nil ? [decodingMethod UTF8String] : "greedy_search",
            maxActivePaths.has_value() ? (int32_t)maxActivePaths.value() : 4,
            hotwordsFile != nil ? [hotwordsFile UTF8String] : "",
            hotwordsScore.has_value() ? (float)hotwordsScore.value() : 1.5f,
            numThreads.has_value() ? (int32_t)numThreads.value() : 1,
            provider != nil ? [provider UTF8String] : "cpu",
            ruleFsts != nil ? [ruleFsts UTF8String] : "",
            ruleFars != nil ? [ruleFars UTF8String] : "",
            dither.has_value() ? (float)dither.value() : 0.f,
            blankPenalty.has_value() ? (float)blankPenalty.value() : 0.f,
            debug.has_value() && debug.value(),
            rule1MustContainNonSilence.has_value() && rule1MustContainNonSilence.value(),
            rule1MinTrailingSilence.has_value() ? (float)rule1MinTrailingSilence.value() : 2.4f,
            rule1MinUtteranceLength.has_value() ? (float)rule1MinUtteranceLength.value() : 0.f,
            rule2MustContainNonSilence.has_value() && rule2MustContainNonSilence.value(),
            rule2MinTrailingSilence.has_value() ? (float)rule2MinTrailingSilence.value() : 1.2f,
            rule2MinUtteranceLength.has_value() ? (float)rule2MinUtteranceLength.value() : 0.f,
            rule3MustContainNonSilence.has_value() && rule3MustContainNonSilence.value(),
            rule3MinTrailingSilence.has_value() ? (float)rule3MinTrailingSilence.value() : 0.f,
            rule3MinUtteranceLength.has_value() ? (float)rule3MinUtteranceLength.value() : 20.f
        );

        if (!result.success) {
            reject(@"STT_INIT_FAILED", [NSString stringWithUTF8String:result.error.c_str()], nil);
            return;
        }

        g_online_stt_instances[instanceIdStr] = std::move(wrapper);
        resolve(@{ @"success": @YES });
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Online STT init failed: %@", exception.reason];
        reject(@"STT_INIT_FAILED", errorMsg, nil);
    }
}

- (void)startSttPipeline:(NSString *)instanceId
       audioInLiveBufferId:(NSString *)audioInLiveBufferId
      textOutLiveBufferId:(NSString *)textOutLiveBufferId
                 chunkSize:(NSNumber *)chunkSize
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(@"STT_PIPELINE_INSTANCE_NOT_FOUND", @"Online STT instance not found", nil);
        return;
    }
    if (audioInLiveBufferId == nil || [audioInLiveBufferId length] == 0) {
        reject(@"STT_PIPELINE_AUDIO_BUFFER_NOT_FOUND", @"Input live audio buffer id is required", nil);
        return;
    }
    if (textOutLiveBufferId == nil || [textOutLiveBufferId length] == 0) {
        reject(@"STT_PIPELINE_TEXT_BUFFER_NOT_FOUND", @"Output live text buffer id is required", nil);
        return;
    }

    std::string instanceKey = [instanceId UTF8String];
    std::string inputBufferKey = [audioInLiveBufferId UTF8String];
    std::string outputBufferKey = [textOutLiveBufferId UTF8String];

    sherpaonnx::OnlineSttWrapper *wrapper = getOnlineSttInstance(instanceId);
    if (!wrapper) {
        reject(@"STT_PIPELINE_INSTANCE_NOT_FOUND", @"Online STT instance not found", nil);
        return;
    }

    std::string existingPipelineId;
    {
        std::lock_guard<std::mutex> lock(g_online_stt_mutex);
        auto pit = g_online_stt_instance_to_pipeline.find(instanceKey);
        if (pit != g_online_stt_instance_to_pipeline.end()) {
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
                    reject(@"STT_PIPELINE_ALREADY_RUNNING",
                           [NSString stringWithFormat:@"STT pipeline already running for instance %@", instanceId],
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
        std::lock_guard<std::mutex> lock(g_online_stt_mutex);
        g_online_stt_instance_to_pipeline.erase(instanceKey);
    }

    std::shared_ptr<PaLiveEntry> inputEntry;
    {
        std::lock_guard<std::mutex> lock(g_pa_mutex);
        auto it = g_pa_live.find(inputBufferKey);
        if (it == g_pa_live.end() || it->second == nullptr) {
            if (g_pa_invalidated_live_ids.find(inputBufferKey) != g_pa_invalidated_live_ids.end()) {
                reject(@"BUFFER_INVALIDATED",
                       [NSString stringWithFormat:@"Input live audio buffer is invalidated after transfer: %@", audioInLiveBufferId], nil);
            } else {
                reject(@"STT_PIPELINE_AUDIO_BUFFER_NOT_FOUND",
                       [NSString stringWithFormat:@"Input live audio buffer not found: %@", audioInLiveBufferId], nil);
            }
            return;
        }
        inputEntry = it->second;
    }

    auto outputEntry = txt_get_live_entry(outputBufferKey);
    if (!outputEntry) {
        reject(@"STT_PIPELINE_TEXT_BUFFER_NOT_FOUND",
               [NSString stringWithFormat:@"Output live text buffer not found: %@", textOutLiveBufferId], nil);
        return;
    }

    if (inputBufferKey.rfind("live_", 0) != 0) {
        reject(@"STT_PIPELINE_BUFFER_KIND_MISMATCH", @"Input buffer must be a live audio buffer", nil);
        return;
    }
    if (inputEntry->state != PaLiveEntry::RECORDING) {
        reject(@"STT_PIPELINE_BUFFER_NOT_RECORDING", @"Input audio buffer is not in recording state", nil);
        return;
    }
    if (!txt_live_is_recording(outputEntry)) {
        reject(@"STT_PIPELINE_BUFFER_NOT_RECORDING", @"Output text buffer is not in recording state", nil);
        return;
    }

    int expectedSampleRate = wrapper->getSampleRate();
    if (inputEntry->sampleRate != expectedSampleRate) {
        reject(@"STT_PIPELINE_SAMPLE_RATE_MISMATCH",
               [NSString stringWithFormat:@"Input buffer sample rate (%d) does not match recognizer sample rate (%d)",
                inputEntry->sampleRate, expectedSampleRate], nil);
        return;
    }

    int safeChunkSize = 6400;
    if (chunkSize != nil && [chunkSize intValue] > 0) {
        safeChunkSize = [chunkSize intValue];
    }

    std::string streamId = std::string("stt_pipeline_stream_") +
      std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());

    if (!wrapper->createStream(streamId, "")) {
        reject(@"STREAMING_PIPELINE_ERROR", @"Failed to create STT pipeline stream", nil);
        return;
    }

    try {
        auto worker = std::make_shared<SttPipelineWorker>(
            wrapper,
            streamId,
            inputEntry,
            outputEntry,
            safeChunkSize
        );

        {
            std::lock_guard<std::mutex> lock(g_streaming_pipeline_mutex);
            g_streaming_pipelines[worker->pipelineId] = worker;
        }
        worker->start();
        so_start_streaming_pipeline_completion_watcher(self, worker->pipelineId, worker);

        {
            std::lock_guard<std::mutex> lock(g_online_stt_mutex);
            g_online_stt_instance_to_pipeline[instanceKey] = worker->pipelineId;
        }

        resolve(@{ @"pipelineId": [NSString stringWithUTF8String:worker->pipelineId.c_str()] });
    } catch (const std::exception &e) {
        wrapper->releaseStream(streamId);
        reject(@"STREAMING_PIPELINE_ERROR", [NSString stringWithUTF8String:e.what()], nil);
    } catch (...) {
        wrapper->releaseStream(streamId);
        reject(@"STREAMING_PIPELINE_ERROR", @"Failed to start STT pipeline", nil);
    }
}

- (void)unloadOnlineStt:(NSString *)instanceId
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        resolve(nil);
        return;
    }

    std::string key = [instanceId UTF8String];
    @try {
        std::string pipelineId;
        {
            std::lock_guard<std::mutex> lock(g_online_stt_mutex);
            auto pit = g_online_stt_instance_to_pipeline.find(key);
            if (pit != g_online_stt_instance_to_pipeline.end()) {
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

        std::lock_guard<std::mutex> lock(g_online_stt_mutex);
        auto it = g_online_stt_instances.find(key);
        if (it != g_online_stt_instances.end()) {
            it->second->unload();
            g_online_stt_instances.erase(it);
        }
        g_online_stt_instance_to_pipeline.erase(key);

        resolve(nil);
    } @catch (NSException *exception) {
        reject(@"STT_INTERNAL_ERROR", [NSString stringWithFormat:@"unloadOnlineStt failed: %@", exception.reason], nil);
    }
}

@end
