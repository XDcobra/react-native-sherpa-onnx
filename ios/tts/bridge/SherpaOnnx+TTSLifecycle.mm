/**
 * SherpaOnnx+TTSLifecycle.mm — Sample rate, speakers, unload.
 */

#import "SherpaOnnx.h"
#import <React/RCTLog.h>
#import <AVFoundation/AVFoundation.h>

#include "engine/TtsEngineStore.h"
#include "native/sherpa-onnx-tts-wrapper.h"

#include <chrono>
#include <mutex>
#include <string>

@implementation SherpaOnnx (TTSLifecycle)

- (void)so_getTtsSampleRate:(NSString *)instanceId
            resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(@"TTS_ERROR", @"instanceId is required", nil);
        return;
    }
    std::string instanceIdStr = [instanceId UTF8String];
    std::lock_guard<std::mutex> lock(g_tts_mutex);
    auto it = g_tts_instances.find(instanceIdStr);
    if (it == g_tts_instances.end() || it->second->wrapper == nullptr || !it->second->wrapper->isInitialized()) {
        reject(@"TTS_NOT_INITIALIZED", @"TTS not initialized. Call initializeTts() first.", nil);
        return;
    }
    int32_t sampleRate = it->second->wrapper->getSampleRate();
    resolve(@(sampleRate));
}

- (void)so_getTtsNumSpeakers:(NSString *)instanceId
             resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(@"TTS_ERROR", @"instanceId is required", nil);
        return;
    }
    std::string instanceIdStr = [instanceId UTF8String];
    std::lock_guard<std::mutex> lock(g_tts_mutex);
    auto it = g_tts_instances.find(instanceIdStr);
    if (it == g_tts_instances.end() || it->second->wrapper == nullptr || !it->second->wrapper->isInitialized()) {
        reject(@"TTS_NOT_INITIALIZED", @"TTS not initialized. Call initializeTts() first.", nil);
        return;
    }
    int32_t numSpeakers = it->second->wrapper->getNumSpeakers();
    resolve(@(numSpeakers));
}

- (void)so_unloadTts:(NSString *)instanceId
     resolve:(RCTPromiseResolveBlock)resolve
     reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        resolve(nil);
        return;
    }
    std::string instanceIdStr = [instanceId UTF8String];
    RCTPromiseResolveBlock resolveCopy = resolve;
    RCTPromiseRejectBlock rejectCopy = reject;
    NSString *instanceIdCopy = [instanceId copy];
    @try {
        dispatch_async(dispatch_get_main_queue(), ^{
            TtsInstanceState *inst = nullptr;
            {
                std::lock_guard<std::mutex> lock(g_tts_mutex);
                auto it = g_tts_instances.find(instanceIdStr);
                if (it == g_tts_instances.end()) {
                    resolveCopy(nil);
                    return;
                }
                inst = it->second.get();
                if (inst->player != nil) [inst->player stop];
                if (inst->engine != nil) {
                    [inst->engine stop];
                    [inst->engine reset];
                }
                inst->player = nil;
                inst->engine = nil;
                inst->format = nil;
                inst->streamCancelled.store(true);
            }
            dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
                {
                    std::unique_lock<std::mutex> lock(g_tts_mutex);
                    auto it = g_tts_instances.find(instanceIdStr);
                    if (it == g_tts_instances.end()) {
                        dispatch_async(dispatch_get_main_queue(), ^{ resolveCopy(nil); });
                        return;
                    }
                    TtsInstanceState *i = it->second.get();
                    bool done = g_tts_stream_cv.wait_for(
                        lock,
                        std::chrono::seconds(5),
                        [i] { return !i->streamRunning.load(); }
                    );
                    if (!done) {
                        RCTLogWarn(@"TTS unload: stream did not stop within 5s, releasing anyway");
                    }
                    if (i->wrapper != nullptr) {
                        i->wrapper->release();
                        i->wrapper.reset();
                    }
                    // Sub-plan 01: clear PCM sink on unload
                    i->sink.clear();
                    i->modelDir = nil;
                    i->modelType = nil;
                    i->provider = nil;
                    i->noiseScale = nil;
                    i->noiseScaleW = nil;
                    i->lengthScale = nil;
                    i->ruleFsts = nil;
                    i->ruleFars = nil;
                    i->maxNumSentences = nil;
                    i->silenceScale = nil;
                    g_tts_instances.erase(it);
                }
                RCTLogInfo(@"TTS instance %@ released", instanceIdCopy);
                dispatch_async(dispatch_get_main_queue(), ^{ resolveCopy(nil); });
            });
        });
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception during TTS cleanup: %@", exception.reason];
        RCTLogError(@"%@", errorMsg);
        rejectCopy(@"TTS_CLEANUP_ERROR", errorMsg, nil);
    }
}

@end
