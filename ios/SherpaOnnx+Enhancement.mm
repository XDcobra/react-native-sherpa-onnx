#import "SherpaOnnx.h"
#import <React/RCTLog.h>

#include "sherpa-onnx-enhancement-wrapper.h"
#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx/c-api/cxx-api.h"
#include "SherpaOnnx+PipelineAudioGlobals.h"

#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

struct EnhancementInstanceState {
    std::unique_ptr<sherpaonnx::EnhancementWrapper> wrapper;
};

struct OnlineEnhancementInstanceState {
    std::unique_ptr<sherpaonnx::OnlineEnhancementWrapper> wrapper;
};

static std::unordered_map<std::string, std::unique_ptr<EnhancementInstanceState>> g_enhancement_instances;
static std::unordered_map<std::string, std::unique_ptr<OnlineEnhancementInstanceState>> g_online_enhancement_instances;
static std::mutex g_enhancement_mutex;

namespace {

static NSString *enhancementKindToNSString(sherpaonnx::EnhancementModelKind kind) {
    using K = sherpaonnx::EnhancementModelKind;
    switch (kind) {
        case K::kGtcrn: return @"gtcrn";
        case K::kDpdfNet: return @"dpdfnet";
        default: return @"unknown";
    }
}

static NSDictionary *enhancedAudioToDict(const sherpaonnx::EnhancedAudioResult& r) {
    NSMutableArray *samples = [NSMutableArray arrayWithCapacity:r.samples.size()];
    for (float s : r.samples) {
        [samples addObject:@(s)];
    }
    return @{
        @"samples": samples,
        @"sampleRate": @(r.sampleRate)
    };
}

static NSDictionary *enhancementDetectResultToDict(const sherpaonnx::EnhancementDetectResult& result) {
    NSMutableArray *detectedModelsArray = [NSMutableArray array];
    for (const auto& model : result.detectedModels) {
        [detectedModelsArray addObject:@{
            @"type": [NSString stringWithUTF8String:model.type.c_str()] ?: @"",
            @"modelDir": [NSString stringWithUTF8String:model.modelDir.c_str()] ?: @""
        }];
    }

    NSMutableDictionary *dict = [@{
        @"success": @(result.ok),
        @"detectedModels": detectedModelsArray,
        @"modelType": enhancementKindToNSString(result.selectedKind),
    } mutableCopy];
    if (!result.detectionSources.empty()) {
        NSMutableArray *sources = [NSMutableArray array];
        for (const auto s : result.detectionSources) {
            [sources addObject:[NSString stringWithUTF8String:sherpaonnx::DetectionSourceToLiteral(s)] ?: @""];
        }
        dict[@"detectionSources"] = sources;
    }
    if (!result.derivedLanguages.empty()) {
        NSMutableArray *langs = [NSMutableArray array];
        for (const auto& id : result.derivedLanguages) {
            [langs addObject:[NSString stringWithUTF8String:id.c_str()] ?: @""];
        }
        dict[@"languages"] = langs;
    }
    if (!result.quantization.empty()) {
        dict[@"quantization"] = [NSString stringWithUTF8String:result.quantization.c_str()] ?: @"";
    }
    if (!result.ok && !result.error.empty()) {
        dict[@"error"] = [NSString stringWithUTF8String:result.error.c_str()] ?: @"Enhancement model detection failed";
    }
    return dict;
}

} // namespace

@implementation SherpaOnnx (Enhancement)

- (void)detectEnhancementModel:(NSString *)modelDir
                     assetName:(NSString *)assetName
                     modelType:(NSString *)modelType
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
    @try {
        std::optional<std::string> modelDirOpt = std::nullopt;
        if (modelDir != nil && [modelDir length] > 0) {
            modelDirOpt = std::string([modelDir UTF8String]);
        }
        std::optional<std::string> assetNameOpt = std::nullopt;
        if (assetName != nil && [assetName length] > 0) {
            assetNameOpt = std::string([assetName UTF8String]);
        }
        std::string modelTypeStr = (modelType != nil && [modelType length] > 0) ? [modelType UTF8String] : "auto";
        auto result = sherpaonnx::DetectEnhancementModel(modelDirOpt, assetNameOpt, modelTypeStr);
        resolve(enhancementDetectResultToDict(result));
    } @catch (NSException *exception) {
        reject(@"DETECT_ERROR",
               [NSString stringWithFormat:@"Enhancement detect failed: %@", exception.reason],
               nil);
    }
}

- (void)initializeEnhancement:(NSString *)instanceId
                     modelDir:(NSString *)modelDir
                    modelType:(NSString *)modelType
                   numThreads:(NSNumber *)numThreads
                     provider:(NSString *)provider
                        debug:(NSNumber *)debug
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(@"ENHANCEMENT_INIT_ERROR", @"instanceId is required", nil);
        return;
    }
    if (modelDir == nil || [modelDir length] == 0) {
        reject(@"ENHANCEMENT_INIT_ERROR", @"modelDir is required", nil);
        return;
    }

    std::string instanceIdStr = [instanceId UTF8String];
    std::string modelDirStr = [modelDir UTF8String];
    std::string modelTypeStr = (modelType != nil && [modelType length] > 0) ? [modelType UTF8String] : "auto";
    int32_t numThreadsVal = numThreads != nil ? [numThreads intValue] : 1;
    bool debugVal = debug != nil && [debug boolValue];
    std::optional<std::string> providerOpt = std::nullopt;
    if (provider != nil && [provider length] > 0) {
        providerOpt = std::string([provider UTF8String]);
    }

    @try {
        std::lock_guard<std::mutex> lock(g_enhancement_mutex);
        auto it = g_enhancement_instances.find(instanceIdStr);
        if (it == g_enhancement_instances.end()) {
            g_enhancement_instances[instanceIdStr] = std::make_unique<EnhancementInstanceState>();
        }
        auto *inst = g_enhancement_instances[instanceIdStr].get();
        if (inst->wrapper == nullptr) {
            inst->wrapper = std::make_unique<sherpaonnx::EnhancementWrapper>();
        }

        auto result = inst->wrapper->initialize(
            modelDirStr,
            modelTypeStr,
            numThreadsVal,
            providerOpt,
            debugVal
        );

        if (!result.success) {
            NSString *errorMsg = result.error.empty()
                ? @"Failed to initialize enhancement"
                : [NSString stringWithUTF8String:result.error.c_str()];
            reject(@"ENHANCEMENT_INIT_ERROR", errorMsg, nil);
            return;
        }

        NSMutableArray *detectedModelsArray = [NSMutableArray array];
        for (const auto& model : result.detectedModels) {
            [detectedModelsArray addObject:@{
                @"type": [NSString stringWithUTF8String:model.type.c_str()] ?: @"",
                @"modelDir": [NSString stringWithUTF8String:model.modelDir.c_str()] ?: @""
            }];
        }

        resolve(@{
            @"success": @YES,
            @"detectedModels": detectedModelsArray,
            @"modelType": [NSString stringWithUTF8String:result.modelType.c_str()] ?: @"unknown",
            @"sampleRate": @(result.sampleRate)
        });
    } @catch (NSException *exception) {
        reject(@"ENHANCEMENT_INIT_ERROR",
               [NSString stringWithFormat:@"Enhancement init failed: %@", exception.reason],
               nil);
    }
}

- (void)enhanceOfflineAudioBuffers:(NSString *)instanceId
                  audioInBufferId:(NSString *)audioInBufferId
                 audioOutBufferId:(NSString *)audioOutBufferId
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(@"ENHANCEMENT_ERROR", @"instanceId is required", nil);
        return;
    }
    if (audioInBufferId == nil || [audioInBufferId length] == 0) {
        reject(@"ENHANCEMENT_BUFFER_NOT_FOUND", @"audioInBufferId is required", nil);
        return;
    }
    if (audioOutBufferId == nil || [audioOutBufferId length] == 0) {
        reject(@"ENHANCEMENT_BUFFER_NOT_FOUND", @"audioOutBufferId is required", nil);
        return;
    }

    std::string instanceIdStr = [instanceId UTF8String];
    std::string audioInId = [audioInBufferId UTF8String];
    std::string audioOutId = [audioOutBufferId UTF8String];

    // Validate input buffer is offline
    if (audioInId.find("off_") != 0) {
        reject(@"ENHANCEMENT_BUFFER_KIND_MISMATCH",
               [NSString stringWithFormat:@"Expected offline audio buffer (off_*) for audioIn, got: %@", audioInBufferId],
               nil);
        return;
    }

    // Validate output buffer is offline
    if (audioOutId.find("off_") != 0) {
        reject(@"ENHANCEMENT_BUFFER_KIND_MISMATCH",
               [NSString stringWithFormat:@"Expected offline audio buffer (off_*) for audioOut, got: %@", audioOutBufferId],
               nil);
        return;
    }

    // Resolve input buffer from registry
    std::shared_ptr<PaOfflineEntry> audioInEntry;
    std::shared_ptr<PaOfflineEntry> audioOutEntry;
    {
        std::lock_guard<std::mutex> paLock(g_pa_mutex);
        auto inIt = g_pa_offline.find(audioInId);
        if (inIt == g_pa_offline.end()) {
            reject(@"ENHANCEMENT_BUFFER_NOT_FOUND",
                   [NSString stringWithFormat:@"Offline audio buffer not found: %@", audioInBufferId],
                   nil);
            return;
        }
        audioInEntry = inIt->second;

        auto outIt = g_pa_offline.find(audioOutId);
        if (outIt == g_pa_offline.end()) {
            reject(@"ENHANCEMENT_BUFFER_NOT_FOUND",
                   [NSString stringWithFormat:@"Offline audio buffer not found: %@", audioOutBufferId],
                   nil);
            return;
        }
        audioOutEntry = outIt->second;
    }

    // Validate input is populated
    if (audioInEntry->sampleRate <= 0 || audioInEntry->numSamples() <= 0) {
        reject(@"ENHANCEMENT_BUFFER_EMPTY",
               [NSString stringWithFormat:@"Input offline audio buffer is empty: %@", audioInBufferId],
               nil);
        return;
    }

    // Validate output is empty
    if (audioOutEntry->isFileBacked || !audioOutEntry->samples.empty()) {
        reject(@"ENHANCEMENT_OUTPUT_NOT_EMPTY",
               [NSString stringWithFormat:@"Output offline audio buffer must be empty: %@", audioOutBufferId],
               nil);
        return;
    }

    @try {
        // Read input samples
        std::vector<float> inputSamples = audioInEntry->readAllSamples();

        // Run denoiser
        sherpaonnx::EnhancedAudioResult enhancedResult;
        {
            std::lock_guard<std::mutex> lock(g_enhancement_mutex);
            auto it = g_enhancement_instances.find(instanceIdStr);
            if (it == g_enhancement_instances.end() || it->second->wrapper == nullptr) {
                reject(@"ENHANCEMENT_ERROR", @"Enhancement instance not found", nil);
                return;
            }
            enhancedResult = it->second->wrapper->runSamples(inputSamples, audioInEntry->sampleRate);
        }

        // Write result into output buffer
        {
            std::lock_guard<std::mutex> paLock(g_pa_mutex);
            if (!audioOutEntry->samples.empty()) {
                reject(@"ENHANCEMENT_OUTPUT_NOT_EMPTY",
                       [NSString stringWithFormat:@"Output buffer was populated concurrently: %@", audioOutBufferId],
                       nil);
                return;
            }
            audioOutEntry->samples = std::move(enhancedResult.samples);
        }

        resolve(nil);
    } @catch (NSException *exception) {
        reject(@"ENHANCEMENT_ERROR",
               [NSString stringWithFormat:@"Enhancement failed: %@", exception.reason],
               nil);
    }
}

- (void)getEnhancementSampleRate:(NSString *)instanceId
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(@"ENHANCEMENT_ERROR", @"instanceId is required", nil);
        return;
    }
    std::string instanceIdStr = [instanceId UTF8String];

    std::lock_guard<std::mutex> lock(g_enhancement_mutex);
    auto it = g_enhancement_instances.find(instanceIdStr);
    if (it == g_enhancement_instances.end() || it->second->wrapper == nullptr) {
        reject(@"ENHANCEMENT_ERROR", @"Enhancement instance not found", nil);
        return;
    }
    resolve(@(it->second->wrapper->getSampleRate()));
}

- (void)unloadEnhancement:(NSString *)instanceId
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        resolve(nil);
        return;
    }
    std::string instanceIdStr = [instanceId UTF8String];
    std::lock_guard<std::mutex> lock(g_enhancement_mutex);
    auto it = g_enhancement_instances.find(instanceIdStr);
    if (it != g_enhancement_instances.end() && it->second->wrapper != nullptr) {
        it->second->wrapper->release();
        g_enhancement_instances.erase(it);
    }
    resolve(nil);
}

- (void)initializeOnlineEnhancement:(NSString *)instanceId
                           modelDir:(NSString *)modelDir
                          modelType:(NSString *)modelType
                         numThreads:(NSNumber *)numThreads
                           provider:(NSString *)provider
                              debug:(NSNumber *)debug
                            resolve:(RCTPromiseResolveBlock)resolve
                             reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(@"ONLINE_ENHANCEMENT_INIT_ERROR", @"instanceId is required", nil);
        return;
    }
    if (modelDir == nil || [modelDir length] == 0) {
        reject(@"ONLINE_ENHANCEMENT_INIT_ERROR", @"modelDir is required", nil);
        return;
    }

    std::string instanceIdStr = [instanceId UTF8String];
    std::string modelDirStr = [modelDir UTF8String];
    std::string modelTypeStr = (modelType != nil && [modelType length] > 0) ? [modelType UTF8String] : "auto";
    int32_t numThreadsVal = numThreads != nil ? [numThreads intValue] : 1;
    bool debugVal = debug != nil && [debug boolValue];
    std::optional<std::string> providerOpt = std::nullopt;
    if (provider != nil && [provider length] > 0) {
        providerOpt = std::string([provider UTF8String]);
    }

    @try {
        std::lock_guard<std::mutex> lock(g_enhancement_mutex);
        auto it = g_online_enhancement_instances.find(instanceIdStr);
        if (it == g_online_enhancement_instances.end()) {
            g_online_enhancement_instances[instanceIdStr] = std::make_unique<OnlineEnhancementInstanceState>();
        }
        auto *inst = g_online_enhancement_instances[instanceIdStr].get();
        if (inst->wrapper == nullptr) {
            inst->wrapper = std::make_unique<sherpaonnx::OnlineEnhancementWrapper>();
        }

        auto result = inst->wrapper->initialize(
            modelDirStr,
            modelTypeStr,
            numThreadsVal,
            providerOpt,
            debugVal
        );
        if (!result.success) {
            NSString *errorMsg = result.error.empty()
                ? @"Failed to initialize online enhancement"
                : [NSString stringWithUTF8String:result.error.c_str()];
            reject(@"ONLINE_ENHANCEMENT_INIT_ERROR", errorMsg, nil);
            return;
        }

        resolve(@{
            @"success": @YES,
            @"sampleRate": @(result.sampleRate),
            @"frameShiftInSamples": @(result.frameShiftInSamples)
        });
    } @catch (NSException *exception) {
        reject(@"ONLINE_ENHANCEMENT_INIT_ERROR",
               [NSString stringWithFormat:@"Online enhancement init failed: %@", exception.reason],
               nil);
    }
}

- (void)feedEnhancementSamples:(NSString *)instanceId
                       samples:(NSArray *)samples
                    sampleRate:(double)sampleRate
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(@"ONLINE_ENHANCEMENT_ERROR", @"instanceId is required", nil);
        return;
    }
    std::string instanceIdStr = [instanceId UTF8String];
    std::vector<float> floatSamples;
    floatSamples.reserve([samples count]);
    for (NSNumber *n in samples) {
        floatSamples.push_back([n floatValue]);
    }

    std::lock_guard<std::mutex> lock(g_enhancement_mutex);
    auto it = g_online_enhancement_instances.find(instanceIdStr);
    if (it == g_online_enhancement_instances.end() || it->second->wrapper == nullptr) {
        reject(@"ONLINE_ENHANCEMENT_ERROR", @"Online enhancement instance not found", nil);
        return;
    }
    auto out = it->second->wrapper->runSamples(floatSamples, static_cast<int32_t>(sampleRate));
    resolve(enhancedAudioToDict(out));
}

- (void)flushOnlineEnhancement:(NSString *)instanceId
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(@"ONLINE_ENHANCEMENT_ERROR", @"instanceId is required", nil);
        return;
    }
    std::string instanceIdStr = [instanceId UTF8String];
    std::lock_guard<std::mutex> lock(g_enhancement_mutex);
    auto it = g_online_enhancement_instances.find(instanceIdStr);
    if (it == g_online_enhancement_instances.end() || it->second->wrapper == nullptr) {
        reject(@"ONLINE_ENHANCEMENT_ERROR", @"Online enhancement instance not found", nil);
        return;
    }
    auto out = it->second->wrapper->flush();
    resolve(enhancedAudioToDict(out));
}

- (void)resetOnlineEnhancement:(NSString *)instanceId
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        resolve(nil);
        return;
    }
    std::string instanceIdStr = [instanceId UTF8String];
    std::lock_guard<std::mutex> lock(g_enhancement_mutex);
    auto it = g_online_enhancement_instances.find(instanceIdStr);
    if (it == g_online_enhancement_instances.end() || it->second->wrapper == nullptr) {
        reject(@"ONLINE_ENHANCEMENT_ERROR", @"Online enhancement instance not found", nil);
        return;
    }
    it->second->wrapper->reset();
    resolve(nil);
}

- (void)unloadOnlineEnhancement:(NSString *)instanceId
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        resolve(nil);
        return;
    }
    std::string instanceIdStr = [instanceId UTF8String];
    std::lock_guard<std::mutex> lock(g_enhancement_mutex);
    auto it = g_online_enhancement_instances.find(instanceIdStr);
    if (it != g_online_enhancement_instances.end() && it->second->wrapper != nullptr) {
        it->second->wrapper->release();
        g_online_enhancement_instances.erase(it);
    }
    resolve(nil);
}

@end
