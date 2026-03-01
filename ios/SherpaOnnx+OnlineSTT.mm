/**
 * SherpaOnnx+OnlineSTT.mm
 *
 * Purpose: iOS TurboModule methods for streaming (online) STT: initializeOnlineSttWithOptions,
 * createSttStream, acceptSttWaveform, decodeSttStream, getSttStreamResult, etc.
 * Uses sherpa-onnx-online-stt-wrapper for native OnlineRecognizer.
 */

#import "SherpaOnnx.h"
#import <React/RCTLog.h>

#include "sherpa-onnx-online-stt-wrapper.h"
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

static std::unordered_map<std::string, std::unique_ptr<sherpaonnx::OnlineSttWrapper>> g_online_stt_instances;
static std::unordered_map<std::string, std::string> g_online_stt_stream_to_instance;
static std::mutex g_online_stt_mutex;

static sherpaonnx::OnlineSttWrapper* getOnlineSttInstance(NSString* instanceId) {
    if (instanceId == nil || [instanceId length] == 0) return nullptr;
    std::string key = [instanceId UTF8String];
    std::lock_guard<std::mutex> lock(g_online_stt_mutex);
    auto it = g_online_stt_instances.find(key);
    return (it != g_online_stt_instances.end() && it->second != nullptr) ? it->second.get() : nullptr;
}

static sherpaonnx::OnlineSttWrapper* getOnlineSttInstanceForStream(NSString* streamId) {
    if (streamId == nil || [streamId length] == 0) return nullptr;
    std::string streamIdStr = [streamId UTF8String];
    std::lock_guard<std::mutex> lock(g_online_stt_mutex);
    auto sit = g_online_stt_stream_to_instance.find(streamIdStr);
    if (sit == g_online_stt_stream_to_instance.end()) return nullptr;
    auto it = g_online_stt_instances.find(sit->second);
    return (it != g_online_stt_instances.end() && it->second != nullptr) ? it->second.get() : nullptr;
}


@implementation SherpaOnnx (OnlineSTT)

- (void)initializeOnlineSttWithOptions:(NSString *)instanceId
                               options:(JS::NativeSherpaOnnx::SpecInitializeOnlineSttWithOptionsOptions &)options
                               resolve:(RCTPromiseResolveBlock)resolve
                                reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(@"INIT_ERROR", @"instanceId is required", nil);
        return;
    }
    NSString *modelDir = options.modelDir();
    NSString *modelType = options.modelType();
    RCTLogInfo(@"[SherpaOnnx OnlineSTT] initializeOnlineSttWithOptions instanceId=%@ modelDir=%@ modelType=%@",
               instanceId, modelDir, modelType);
    if (modelDir == nil || [modelDir length] == 0) {
        reject(@"INIT_ERROR", @"modelDir is required", nil);
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
            reject(@"INIT_ERROR", @"Online STT instance already exists", nil);
            return;
        }
        RCTLogInfo(@"[SherpaOnnx OnlineSTT] creating wrapper and calling initialize");
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
            RCTLogError(@"[SherpaOnnx OnlineSTT] initialize failed: %s", result.error.c_str());
            reject(@"INIT_ERROR", [NSString stringWithUTF8String:result.error.c_str()], nil);
            return;
        }
        g_online_stt_instances[instanceIdStr] = std::move(wrapper);
        RCTLogInfo(@"[SherpaOnnx OnlineSTT] init success for instanceId=%@", instanceId);
        resolve(@{ @"success": @YES });
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Online STT init failed: %@", exception.reason];
        RCTLogError(@"%@", errorMsg);
        reject(@"INIT_ERROR", errorMsg, nil);
    }
}

- (void)createSttStream:(NSString *)instanceId
              streamId:(NSString *)streamId
              hotwords:(NSString *)hotwords
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
    sherpaonnx::OnlineSttWrapper* wrapper = getOnlineSttInstance(instanceId);
    if (wrapper == nullptr) {
        reject(@"STREAM_ERROR", @"Online STT instance not found", nil);
        return;
    }
    std::string instanceIdStr = [instanceId UTF8String];
    std::string streamIdStr = [streamId UTF8String];
    std::string hotwordsStr = hotwords != nil ? [hotwords UTF8String] : "";
    if (!wrapper->createStream(streamIdStr, hotwordsStr)) {
        reject(@"STREAM_ERROR", @"Stream already exists or create failed", nil);
        return;
    }
    std::lock_guard<std::mutex> lock(g_online_stt_mutex);
    g_online_stt_stream_to_instance[streamIdStr] = instanceIdStr;
    resolve(nil);
}

- (void)acceptSttWaveform:(NSString *)streamId
                  samples:(NSArray *)samples
               sampleRate:(double)sampleRate
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
    sherpaonnx::OnlineSttWrapper* wrapper = getOnlineSttInstanceForStream(streamId);
    if (wrapper == nullptr) {
        reject(@"STREAM_ERROR", @"Stream not found", nil);
        return;
    }
    std::vector<float> floatSamples;
    floatSamples.reserve([samples count]);
    for (NSNumber* n in samples) {
        floatSamples.push_back([n floatValue]);
    }
    std::string streamIdStr = [streamId UTF8String];
    wrapper->acceptWaveform(streamIdStr, (int32_t)sampleRate, floatSamples.data(), floatSamples.size());
    resolve(nil);
}

- (void)sttStreamInputFinished:(NSString *)streamId
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
    sherpaonnx::OnlineSttWrapper* wrapper = getOnlineSttInstanceForStream(streamId);
    if (wrapper == nullptr) {
        reject(@"STREAM_ERROR", @"Stream not found", nil);
        return;
    }
    std::string streamIdStr = [streamId UTF8String];
    wrapper->inputFinished(streamIdStr);
    resolve(nil);
}

- (void)decodeSttStream:(NSString *)streamId
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
    sherpaonnx::OnlineSttWrapper* wrapper = getOnlineSttInstanceForStream(streamId);
    if (wrapper == nullptr) {
        reject(@"STREAM_ERROR", @"Stream not found", nil);
        return;
    }
    std::string streamIdStr = [streamId UTF8String];
    wrapper->decode(streamIdStr);
    resolve(nil);
}

- (void)isSttStreamReady:(NSString *)streamId
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
    sherpaonnx::OnlineSttWrapper* wrapper = getOnlineSttInstanceForStream(streamId);
    if (wrapper == nullptr) {
        reject(@"STREAM_ERROR", @"Stream not found", nil);
        return;
    }
    std::string streamIdStr = [streamId UTF8String];
    BOOL ready = wrapper->isReady(streamIdStr);
    resolve(@(ready));
}

- (void)getSttStreamResult:(NSString *)streamId
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
    sherpaonnx::OnlineSttWrapper* wrapper = getOnlineSttInstanceForStream(streamId);
    if (wrapper == nullptr) {
        reject(@"STREAM_ERROR", @"Stream not found", nil);
        return;
    }
    std::string streamIdStr = [streamId UTF8String];
    sherpaonnx::OnlineSttStreamResult r = wrapper->getResult(streamIdStr);
    NSMutableArray* tokens = [NSMutableArray arrayWithCapacity:r.tokens.size()];
    for (const auto& t : r.tokens) {
        [tokens addObject:[NSString stringWithUTF8String:t.c_str()]];
    }
    NSMutableArray* timestamps = [NSMutableArray arrayWithCapacity:r.timestamps.size()];
    for (float ts : r.timestamps) {
        [timestamps addObject:@(ts)];
    }
    resolve(@{
        @"text": [NSString stringWithUTF8String:r.text.c_str()] ?: @"",
        @"tokens": tokens,
        @"timestamps": timestamps
    });
}

- (void)isSttStreamEndpoint:(NSString *)streamId
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
    sherpaonnx::OnlineSttWrapper* wrapper = getOnlineSttInstanceForStream(streamId);
    if (wrapper == nullptr) {
        reject(@"STREAM_ERROR", @"Stream not found", nil);
        return;
    }
    std::string streamIdStr = [streamId UTF8String];
    BOOL endpoint = wrapper->isEndpoint(streamIdStr);
    resolve(@(endpoint));
}

- (void)resetSttStream:(NSString *)streamId
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
    sherpaonnx::OnlineSttWrapper* wrapper = getOnlineSttInstanceForStream(streamId);
    if (wrapper == nullptr) {
        reject(@"STREAM_ERROR", @"Stream not found", nil);
        return;
    }
    std::string streamIdStr = [streamId UTF8String];
    wrapper->resetStream(streamIdStr);
    resolve(nil);
}

- (void)releaseSttStream:(NSString *)streamId
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
    sherpaonnx::OnlineSttWrapper* wrapper = getOnlineSttInstanceForStream(streamId);
    std::string streamIdStr = [streamId UTF8String];
    if (wrapper != nullptr) {
        wrapper->releaseStream(streamIdStr);
    }
    {
        std::lock_guard<std::mutex> lock(g_online_stt_mutex);
        g_online_stt_stream_to_instance.erase(streamIdStr);
    }
    resolve(nil);
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
        std::lock_guard<std::mutex> lock(g_online_stt_mutex);
        auto it = g_online_stt_instances.find(key);
        if (it != g_online_stt_instances.end()) {
            it->second->unload();
            for (auto sit = g_online_stt_stream_to_instance.begin(); sit != g_online_stt_stream_to_instance.end(); ) {
                if (sit->second == key) sit = g_online_stt_stream_to_instance.erase(sit);
                else ++sit;
            }
            g_online_stt_instances.erase(it);
        }
        resolve(nil);
    } @catch (NSException *exception) {
        reject(@"RELEASE_ERROR", [NSString stringWithFormat:@"unloadOnlineStt failed: %@", exception.reason], nil);
    }
}

- (void)processSttAudioChunk:(NSString *)streamId
                     samples:(NSArray *)samples
                  sampleRate:(double)sampleRate
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject
{
    sherpaonnx::OnlineSttWrapper* wrapper = getOnlineSttInstanceForStream(streamId);
    if (wrapper == nullptr) {
        reject(@"STREAM_ERROR", @"Stream not found", nil);
        return;
    }
    std::string streamIdStr = [streamId UTF8String];
    std::vector<float> floatSamples;
    NSUInteger count = [samples count];
    floatSamples.reserve(count);
    for (NSUInteger i = 0; i < count; i++) {
        id obj = [samples objectAtIndex:i];
        float val = 0.0f;
        if ([obj isKindOfClass:[NSNumber class]]) {
            val = [(NSNumber *)obj floatValue];
        } else if ([obj respondsToSelector:@selector(doubleValue)]) {
            val = (float)[(id)obj doubleValue];
        }
        floatSamples.push_back(val);
    }
    if (floatSamples.empty()) {
        RCTLogWarn(@"[SherpaOnnx OnlineSTT] processSttAudioChunk: no samples (count=%lu)", (unsigned long)count);
    }

    wrapper->acceptWaveform(streamIdStr, (int32_t)sampleRate, floatSamples.data(), floatSamples.size());
    while (wrapper->isReady(streamIdStr)) {
        wrapper->decode(streamIdStr);
    }
    sherpaonnx::OnlineSttStreamResult r = wrapper->getResult(streamIdStr);
    BOOL isEndpoint = wrapper->isEndpoint(streamIdStr);
    NSMutableArray* tokens = [NSMutableArray arrayWithCapacity:r.tokens.size()];
    for (const auto& t : r.tokens) {
        [tokens addObject:[NSString stringWithUTF8String:t.c_str()]];
    }
    NSMutableArray* timestamps = [NSMutableArray arrayWithCapacity:r.timestamps.size()];
    for (float ts : r.timestamps) {
        [timestamps addObject:@(ts)];
    }
    resolve(@{
        @"text": [NSString stringWithUTF8String:r.text.c_str()] ?: @"",
        @"tokens": tokens,
        @"timestamps": timestamps,
        @"isEndpoint": @(isEndpoint)
    });
}

@end
