/**
 * SherpaOnnx+KWS.mm
 *
 * Purpose: iOS TurboModule methods for keyword spotting: initializeKwsWithOptions,
 * createKwsStream, acceptKwsWaveform, decodeKwsStream, getKwsStreamResult, etc.
 * Uses sherpa-onnx-kws-wrapper for native KeywordSpotter.
 */

#import "SherpaOnnx.h"
#import <React/RCTLog.h>

#include "sherpa-onnx-kws-wrapper.h"
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

static std::unordered_map<std::string, std::unique_ptr<sherpaonnx::KwsWrapper>> g_kws_instances;
static std::unordered_map<std::string, std::string> g_kws_stream_to_instance;
static std::mutex g_kws_mutex;

static sherpaonnx::KwsWrapper* getKwsInstance(NSString* instanceId) {
    if (instanceId == nil || [instanceId length] == 0) return nullptr;
    std::string key = [instanceId UTF8String];
    std::lock_guard<std::mutex> lock(g_kws_mutex);
    auto it = g_kws_instances.find(key);
    return (it != g_kws_instances.end() && it->second != nullptr) ? it->second.get() : nullptr;
}

static sherpaonnx::KwsWrapper* getKwsInstanceForStream(NSString* streamId) {
    if (streamId == nil || [streamId length] == 0) return nullptr;
    std::string streamIdStr = [streamId UTF8String];
    std::lock_guard<std::mutex> lock(g_kws_mutex);
    auto sit = g_kws_stream_to_instance.find(streamIdStr);
    if (sit == g_kws_stream_to_instance.end()) return nullptr;
    auto it = g_kws_instances.find(sit->second);
    return (it != g_kws_instances.end() && it->second != nullptr) ? it->second.get() : nullptr;
}


@implementation SherpaOnnx (KWS)

- (void)initializeKwsWithOptions:(NSString *)instanceId
                         options:(JS::NativeSherpaOnnx::SpecInitializeKwsWithOptionsOptions &)options
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(@"INIT_ERROR", @"instanceId is required", nil);
        return;
    }
    NSString *modelDir = options.modelDir();
    NSString *modelType = options.modelType();
    RCTLogInfo(@"[SherpaOnnx KWS] initializeKwsWithOptions instanceId=%@ modelDir=%@ modelType=%@",
               instanceId, modelDir, modelType);
    if (modelDir == nil || [modelDir length] == 0) {
        reject(@"INIT_ERROR", @"modelDir is required", nil);
        return;
    }
    std::string instanceIdStr = [instanceId UTF8String];
    std::string modelDirStr = [modelDir UTF8String];

    NSString *keywordsFile = options.keywordsFile();
    auto keywordsScore = options.keywordsScore();
    auto keywordsThreshold = options.keywordsThreshold();
    auto numTrailingBlanks = options.numTrailingBlanks();
    auto maxActivePaths = options.maxActivePaths();
    auto numThreads = options.numThreads();
    NSString *provider = options.provider();
    auto debug = options.debug();

    @try {
        std::lock_guard<std::mutex> lock(g_kws_mutex);
        if (g_kws_instances.find(instanceIdStr) != g_kws_instances.end()) {
            reject(@"INIT_ERROR", @"KWS instance already exists", nil);
            return;
        }
        RCTLogInfo(@"[SherpaOnnx KWS] creating wrapper and calling initialize");
        auto wrapper = std::make_unique<sherpaonnx::KwsWrapper>();
        sherpaonnx::KwsInitResult result = wrapper->initialize(
            modelDirStr,
            keywordsFile != nil ? [keywordsFile UTF8String] : "",
            keywordsScore.has_value() ? (float)keywordsScore.value() : 1.5f,
            keywordsThreshold.has_value() ? (float)keywordsThreshold.value() : 0.25f,
            numTrailingBlanks.has_value() ? (int32_t)numTrailingBlanks.value() : 2,
            maxActivePaths.has_value() ? (int32_t)maxActivePaths.value() : 4,
            numThreads.has_value() ? (int32_t)numThreads.value() : 1,
            provider != nil ? [provider UTF8String] : "cpu",
            debug.has_value() && debug.value()
        );
        if (!result.success) {
            RCTLogError(@"[SherpaOnnx KWS] initialize failed: %s", result.error.c_str());
            reject(@"INIT_ERROR", [NSString stringWithUTF8String:result.error.c_str()], nil);
            return;
        }
        g_kws_instances[instanceIdStr] = std::move(wrapper);
        RCTLogInfo(@"[SherpaOnnx KWS] init success for instanceId=%@", instanceId);
        resolve(@{ @"success": @YES });
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"KWS init failed: %@", exception.reason];
        RCTLogError(@"%@", errorMsg);
        reject(@"INIT_ERROR", errorMsg, nil);
    }
}

- (void)createKwsStream:(NSString *)instanceId
             streamId:(NSString *)streamId
             keywords:(NSString *)keywords
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
    sherpaonnx::KwsWrapper* wrapper = getKwsInstance(instanceId);
    if (wrapper == nullptr) {
        reject(@"STREAM_ERROR", @"KWS instance not found", nil);
        return;
    }
    std::string instanceIdStr = [instanceId UTF8String];
    std::string streamIdStr = [streamId UTF8String];
    std::string keywordsStr = keywords != nil ? [keywords UTF8String] : "";
    if (!wrapper->createStream(streamIdStr, keywordsStr)) {
        reject(@"STREAM_ERROR", @"Stream already exists or create failed", nil);
        return;
    }
    std::lock_guard<std::mutex> lock(g_kws_mutex);
    g_kws_stream_to_instance[streamIdStr] = instanceIdStr;
    resolve(nil);
}

- (void)acceptKwsWaveform:(NSString *)streamId
                  samples:(NSArray *)samples
               sampleRate:(double)sampleRate
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
    sherpaonnx::KwsWrapper* wrapper = getKwsInstanceForStream(streamId);
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

- (void)decodeKwsStream:(NSString *)streamId
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
    sherpaonnx::KwsWrapper* wrapper = getKwsInstanceForStream(streamId);
    if (wrapper == nullptr) {
        reject(@"STREAM_ERROR", @"Stream not found", nil);
        return;
    }
    std::string streamIdStr = [streamId UTF8String];
    wrapper->decode(streamIdStr);
    resolve(nil);
}

- (void)isKwsStreamReady:(NSString *)streamId
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
    sherpaonnx::KwsWrapper* wrapper = getKwsInstanceForStream(streamId);
    if (wrapper == nullptr) {
        reject(@"STREAM_ERROR", @"Stream not found", nil);
        return;
    }
    std::string streamIdStr = [streamId UTF8String];
    BOOL ready = wrapper->isReady(streamIdStr);
    resolve(@(ready));
}

- (void)getKwsStreamResult:(NSString *)streamId
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
    sherpaonnx::KwsWrapper* wrapper = getKwsInstanceForStream(streamId);
    if (wrapper == nullptr) {
        reject(@"STREAM_ERROR", @"Stream not found", nil);
        return;
    }
    std::string streamIdStr = [streamId UTF8String];
    sherpaonnx::KwsStreamResult r = wrapper->getResult(streamIdStr);
    NSMutableArray* tokens = [NSMutableArray arrayWithCapacity:r.tokens.size()];
    for (const auto& t : r.tokens) {
        [tokens addObject:[NSString stringWithUTF8String:t.c_str()]];
    }
    NSMutableArray* timestamps = [NSMutableArray arrayWithCapacity:r.timestamps.size()];
    for (float ts : r.timestamps) {
        [timestamps addObject:@(ts)];
    }
    resolve(@{
        @"keyword": [NSString stringWithUTF8String:r.keyword.c_str()] ?: @"",
        @"tokens": tokens,
        @"timestamps": timestamps
    });
}

- (void)resetKwsStream:(NSString *)streamId
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
    sherpaonnx::KwsWrapper* wrapper = getKwsInstanceForStream(streamId);
    if (wrapper == nullptr) {
        reject(@"STREAM_ERROR", @"Stream not found", nil);
        return;
    }
    std::string streamIdStr = [streamId UTF8String];
    wrapper->resetStream(streamIdStr);
    resolve(nil);
}

- (void)releaseKwsStream:(NSString *)streamId
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
    sherpaonnx::KwsWrapper* wrapper = getKwsInstanceForStream(streamId);
    std::string streamIdStr = [streamId UTF8String];
    if (wrapper != nullptr) {
        wrapper->releaseStream(streamIdStr);
    }
    {
        std::lock_guard<std::mutex> lock(g_kws_mutex);
        g_kws_stream_to_instance.erase(streamIdStr);
    }
    resolve(nil);
}

- (void)unloadKws:(NSString *)instanceId
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        resolve(nil);
        return;
    }
    std::string key = [instanceId UTF8String];
    @try {
        std::lock_guard<std::mutex> lock(g_kws_mutex);
        auto it = g_kws_instances.find(key);
        if (it != g_kws_instances.end()) {
            it->second->unload();
            for (auto sit = g_kws_stream_to_instance.begin(); sit != g_kws_stream_to_instance.end(); ) {
                if (sit->second == key) sit = g_kws_stream_to_instance.erase(sit);
                else ++sit;
            }
            g_kws_instances.erase(it);
        }
        resolve(nil);
    } @catch (NSException *exception) {
        reject(@"RELEASE_ERROR", [NSString stringWithFormat:@"unloadKws failed: %@", exception.reason], nil);
    }
}

- (void)processKwsAudioChunk:(NSString *)streamId
                     samples:(NSArray *)samples
                  sampleRate:(double)sampleRate
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject
{
    sherpaonnx::KwsWrapper* wrapper = getKwsInstanceForStream(streamId);
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
        RCTLogWarn(@"[SherpaOnnx KWS] processKwsAudioChunk: no samples (count=%lu)", (unsigned long)count);
    }

    wrapper->acceptWaveform(streamIdStr, (int32_t)sampleRate, floatSamples.data(), floatSamples.size());
    while (wrapper->isReady(streamIdStr)) {
        wrapper->decode(streamIdStr);
    }
    sherpaonnx::KwsStreamResult r = wrapper->getResult(streamIdStr);
    if (!r.keyword.empty()) {
        wrapper->resetStream(streamIdStr);
    }
    NSMutableArray* tokens = [NSMutableArray arrayWithCapacity:r.tokens.size()];
    for (const auto& t : r.tokens) {
        [tokens addObject:[NSString stringWithUTF8String:t.c_str()]];
    }
    NSMutableArray* timestamps = [NSMutableArray arrayWithCapacity:r.timestamps.size()];
    for (float ts : r.timestamps) {
        [timestamps addObject:@(ts)];
    }
    resolve(@{
        @"keyword": [NSString stringWithUTF8String:r.keyword.c_str()] ?: @"",
        @"tokens": tokens,
        @"timestamps": timestamps
    });
}

@end
