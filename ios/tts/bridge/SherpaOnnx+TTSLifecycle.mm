/**
 * SherpaOnnx+TTSLifecycle.mm — Sample rate, speakers, unload.
 */

#import "SherpaOnnx.h"
#import <React/RCTLog.h>
#import <AVFoundation/AVFoundation.h>

#include "engine/TtsEngineStore.h"
#include "native/sherpa-onnx-tts-wrapper.h"

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
    @try {
        {
            std::lock_guard<std::mutex> lock(g_tts_mutex);
            auto it = g_tts_instances.find(instanceIdStr);
            if (it != g_tts_instances.end()) {
                TtsInstanceState *i = it->second.get();
                if (i->wrapper != nullptr) {
                    i->wrapper->release();
                    i->wrapper.reset();
                }
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
        }
        RCTLogInfo(@"TTS instance %@ released", instanceId);
        resolve(nil);
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception during TTS cleanup: %@", exception.reason];
        RCTLogError(@"%@", errorMsg);
        reject(@"TTS_CLEANUP_ERROR", errorMsg, nil);
    }
}

@end
