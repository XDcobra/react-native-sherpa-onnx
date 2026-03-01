/**
 * SherpaOnnx+TTS.mm
 *
 * Purpose: TTS (text-to-speech) TurboModule methods: createTTS, releaseTTS, generateTTS, and event
 * emission. Uses sherpa-onnx-tts-wrapper for native synthesis and sherpa-onnx-model-detect for model detection.
 */

#import "SherpaOnnx.h"
#import <React/RCTLog.h>
#import <React/RCTUtils.h>
#import <UIKit/UIKit.h>
#import <AVFoundation/AVFoundation.h>

#include "sherpa-onnx-tts-wrapper.h"
#include "sherpa-onnx-model-detect.h"
#include <atomic>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>
#include <chrono>

struct TtsInstanceState {
    std::unique_ptr<sherpaonnx::TtsWrapper> wrapper;
    std::atomic<bool> streamRunning{false};
    std::atomic<bool> streamCancelled{false};
    __strong AVAudioEngine *engine = nil;
    __strong AVAudioPlayerNode *player = nil;
    __strong AVAudioFormat *format = nil;
    __strong NSString *modelDir = nil;
    __strong NSString *modelType = nil;
    int32_t numThreads = 2;
    BOOL debug = NO;
    __strong NSNumber *noiseScale = nil;
    __strong NSNumber *noiseScaleW = nil;
    __strong NSNumber *lengthScale = nil;
    __strong NSString *ruleFsts = nil;
    __strong NSString *ruleFars = nil;
    __strong NSNumber *maxNumSentences = nil;
    __strong NSNumber *silenceScale = nil;
    __strong NSString *provider = nil;
};

static std::unordered_map<std::string, std::shared_ptr<TtsInstanceState>> g_tts_instances;
static std::mutex g_tts_mutex;
static std::condition_variable g_tts_stream_cv;

static NSString *ttsModelKindToNSString(sherpaonnx::TtsModelKind kind) {
    using K = sherpaonnx::TtsModelKind;
    switch (kind) {
        case K::kVits: return @"vits";
        case K::kMatcha: return @"matcha";
        case K::kKokoro: return @"kokoro";
        case K::kKitten: return @"kitten";
        case K::kZipvoice: return @"zipvoice";
        default: return @"unknown";
    }
}

namespace {
std::vector<std::string> SplitTtsTokens(const std::string &text) {
    std::vector<std::string> tokens;
    std::istringstream iss(text);
    std::string token;
    while (iss >> token) {
        tokens.push_back(token);
    }
    if (tokens.empty() && !text.empty()) {
        tokens.push_back(text);
    }
    return tokens;
}
}

@implementation SherpaOnnx (TTS)

- (void)initializeTts:(NSString *)instanceId
            modelDir:(NSString *)modelDir
            modelType:(NSString *)modelType
           numThreads:(double)numThreads
                debug:(BOOL)debug
           noiseScale:(NSNumber *)noiseScale
          noiseScaleW:(NSNumber *)noiseScaleW
           lengthScale:(NSNumber *)lengthScale
              ruleFsts:(NSString *)ruleFsts
              ruleFars:(NSString *)ruleFars
       maxNumSentences:(NSNumber *)maxNumSentences
         silenceScale:(NSNumber *)silenceScale
            provider:(NSString *)provider
         resolve:(RCTPromiseResolveBlock)resolve
         reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(@"TTS_INIT_ERROR", @"instanceId is required", nil);
        return;
    }
    std::string instanceIdStr = [instanceId UTF8String];
    RCTLogInfo(@"Initializing TTS instance %@ with modelDir: %@, modelType: %@", instanceId, modelDir, modelType);

    @try {
        std::lock_guard<std::mutex> lock(g_tts_mutex);
        auto it = g_tts_instances.find(instanceIdStr);
        if (it == g_tts_instances.end()) {
            g_tts_instances[instanceIdStr] = std::make_shared<TtsInstanceState>();
        }
        TtsInstanceState *inst = g_tts_instances[instanceIdStr].get();
        if (inst->wrapper == nullptr) {
            inst->wrapper = std::make_unique<sherpaonnx::TtsWrapper>();
        }

        std::string modelDirStr = [modelDir UTF8String];
        std::string modelTypeStr = [modelType UTF8String];

        std::optional<float> noiseScaleOpt = std::nullopt;
        std::optional<float> noiseScaleWOpt = std::nullopt;
        std::optional<float> lengthScaleOpt = std::nullopt;
        if (noiseScale != nil) {
            noiseScaleOpt = [noiseScale floatValue];
        }
        if (noiseScaleW != nil) {
            noiseScaleWOpt = [noiseScaleW floatValue];
        }
        if (lengthScale != nil) {
            lengthScaleOpt = [lengthScale floatValue];
        }

        std::optional<std::string> ruleFstsOpt = std::nullopt;
        std::optional<std::string> ruleFarsOpt = std::nullopt;
        std::optional<int32_t> maxNumSentencesOpt = std::nullopt;
        std::optional<float> silenceScaleOpt = std::nullopt;
        if (ruleFsts != nil && [ruleFsts length] > 0) {
            ruleFstsOpt = std::string([ruleFsts UTF8String]);
        }
        if (ruleFars != nil && [ruleFars length] > 0) {
            ruleFarsOpt = std::string([ruleFars UTF8String]);
        }
        if (maxNumSentences != nil && [maxNumSentences intValue] >= 1) {
            maxNumSentencesOpt = static_cast<int32_t>([maxNumSentences intValue]);
        }
        if (silenceScale != nil) {
            silenceScaleOpt = [silenceScale floatValue];
        }
        std::optional<std::string> providerOpt = std::nullopt;
        if (provider != nil && [provider length] > 0) {
            providerOpt = std::string([provider UTF8String]);
        }

        sherpaonnx::TtsInitializeResult result = inst->wrapper->initialize(
            modelDirStr,
            modelTypeStr,
            static_cast<int32_t>(numThreads),
            debug,
            noiseScaleOpt,
            noiseScaleWOpt,
            lengthScaleOpt,
            ruleFstsOpt,
            ruleFarsOpt,
            maxNumSentencesOpt,
            silenceScaleOpt,
            providerOpt
        );

        if (result.success) {
            RCTLogInfo(@"TTS initialization successful for instance %@", instanceId);

            inst->modelDir = [modelDir copy];
            inst->modelType = [modelType copy];
            inst->numThreads = static_cast<int32_t>(numThreads);
            inst->debug = debug;
            inst->noiseScale = noiseScale ? [noiseScale copy] : nil;
            inst->noiseScaleW = noiseScaleW ? [noiseScaleW copy] : nil;
            inst->lengthScale = lengthScale ? [lengthScale copy] : nil;
            inst->ruleFsts = (ruleFsts != nil && [ruleFsts length] > 0) ? [ruleFsts copy] : nil;
            inst->ruleFars = (ruleFars != nil && [ruleFars length] > 0) ? [ruleFars copy] : nil;
            inst->maxNumSentences = (maxNumSentences != nil && [maxNumSentences intValue] >= 1) ? [maxNumSentences copy] : nil;
            inst->silenceScale = silenceScale ? [silenceScale copy] : nil;
            inst->provider = (provider != nil && [provider length] > 0) ? [provider copy] : nil;

            NSMutableArray *detectedModelsArray = [NSMutableArray array];
            for (const auto& model : result.detectedModels) {
                NSDictionary *modelDict = @{
                    @"type": [NSString stringWithUTF8String:model.type.c_str()],
                    @"modelDir": [NSString stringWithUTF8String:model.modelDir.c_str()]
                };
                [detectedModelsArray addObject:modelDict];
            }

            NSDictionary *resultDict = @{
                @"success": @YES,
                @"detectedModels": detectedModelsArray
            };

            resolve(resultDict);
        } else {
            NSString *errorMsg = @"Failed to initialize TTS";
            RCTLogError(@"%@", errorMsg);
            reject(@"TTS_INIT_ERROR", errorMsg, nil);
        }
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception during TTS init: %@", exception.reason];
        RCTLogError(@"%@", errorMsg);
        reject(@"TTS_INIT_ERROR", errorMsg, nil);
    }
}

- (void)detectTtsModel:(NSString *)modelDir
            modelType:(NSString *)modelType
         resolve:(RCTPromiseResolveBlock)resolve
         reject:(RCTPromiseRejectBlock)reject
{
    RCTLogInfo(@"Detecting TTS model in: %@", modelDir);
    @try {
        std::string modelDirStr = [modelDir UTF8String];
        std::string modelTypeStr = (modelType != nil && [modelType length] > 0 && ![modelType isEqualToString:@"auto"])
            ? [modelType UTF8String] : "auto";
        sherpaonnx::TtsDetectResult result = sherpaonnx::DetectTtsModel(modelDirStr, modelTypeStr);

        NSMutableDictionary *resultDict = [NSMutableDictionary dictionary];
        resultDict[@"success"] = @(result.ok);
        if (!result.error.empty()) {
            resultDict[@"error"] = [NSString stringWithUTF8String:result.error.c_str()];
        }
        NSMutableArray *detectedModelsArray = [NSMutableArray array];
        for (const auto& model : result.detectedModels) {
            [detectedModelsArray addObject:@{
                @"type": [NSString stringWithUTF8String:model.type.c_str()],
                @"modelDir": [NSString stringWithUTF8String:model.modelDir.c_str()]
            }];
        }
        resultDict[@"detectedModels"] = detectedModelsArray;
        resultDict[@"modelType"] = ttsModelKindToNSString(result.selectedKind);
        resolve(resultDict);
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"TTS model detection failed: %@", exception.reason];
        RCTLogError(@"%@", errorMsg);
        reject(@"DETECT_ERROR", errorMsg, nil);
    }
}

- (void)updateTtsParams:(NSString *)instanceId
            noiseScale:(NSNumber *)noiseScale
           noiseScaleW:(NSNumber *)noiseScaleW
           lengthScale:(NSNumber *)lengthScale
           resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(@"TTS_UPDATE_ERROR", @"instanceId is required", nil);
        return;
    }
    std::string instanceIdStr = [instanceId UTF8String];
    std::lock_guard<std::mutex> lock(g_tts_mutex);
    auto it = g_tts_instances.find(instanceIdStr);
    if (it == g_tts_instances.end() || it->second->wrapper == nullptr || it->second->modelDir == nil || it->second->modelType == nil) {
        reject(@"TTS_UPDATE_ERROR", @"TTS instance not found or not initialized", nil);
        return;
    }
    TtsInstanceState *inst = it->second.get();
    if (inst->streamRunning.load()) {
        reject(@"TTS_UPDATE_ERROR", @"Cannot update params while streaming", nil);
        return;
    }

    NSNumber *nextNoiseScale = nil;
    if (noiseScale == nil) {
        nextNoiseScale = nil;
    } else if (isnan([noiseScale doubleValue])) {
        nextNoiseScale = inst->noiseScale;
    } else {
        nextNoiseScale = noiseScale;
    }

    NSNumber *nextNoiseScaleW = nil;
    if (noiseScaleW == nil) {
        nextNoiseScaleW = nil;
    } else if (isnan([noiseScaleW doubleValue])) {
        nextNoiseScaleW = inst->noiseScaleW;
    } else {
        nextNoiseScaleW = noiseScaleW;
    }

    NSNumber *nextLengthScale = nil;
    if (lengthScale == nil) {
        nextLengthScale = nil;
    } else if (isnan([lengthScale doubleValue])) {
        nextLengthScale = inst->lengthScale;
    } else {
        nextLengthScale = lengthScale;
    }

    @try {
        std::optional<float> noiseScaleOpt = std::nullopt;
        std::optional<float> noiseScaleWOpt = std::nullopt;
        std::optional<float> lengthScaleOpt = std::nullopt;
        if (nextNoiseScale != nil) {
            noiseScaleOpt = [nextNoiseScale floatValue];
        }
        if (nextNoiseScaleW != nil) {
            noiseScaleWOpt = [nextNoiseScaleW floatValue];
        }
        if (nextLengthScale != nil) {
            lengthScaleOpt = [nextLengthScale floatValue];
        }

        std::optional<std::string> ruleFstsOpt = std::nullopt;
        std::optional<std::string> ruleFarsOpt = std::nullopt;
        std::optional<int32_t> maxNumSentencesOpt = std::nullopt;
        std::optional<float> silenceScaleOpt = std::nullopt;
        if (inst->ruleFsts != nil && [inst->ruleFsts length] > 0) {
            ruleFstsOpt = std::string([inst->ruleFsts UTF8String]);
        }
        if (inst->ruleFars != nil && [inst->ruleFars length] > 0) {
            ruleFarsOpt = std::string([inst->ruleFars UTF8String]);
        }
        if (inst->maxNumSentences != nil && [inst->maxNumSentences intValue] >= 1) {
            maxNumSentencesOpt = static_cast<int32_t>([inst->maxNumSentences intValue]);
        }
        if (inst->silenceScale != nil) {
            silenceScaleOpt = [inst->silenceScale floatValue];
        }
        std::optional<std::string> providerOpt = std::nullopt;
        if (inst->provider != nil && [inst->provider length] > 0) {
            providerOpt = std::string([inst->provider UTF8String]);
        }

        sherpaonnx::TtsInitializeResult result = inst->wrapper->initialize(
            std::string([inst->modelDir UTF8String]),
            std::string([inst->modelType UTF8String]),
            inst->numThreads,
            inst->debug,
            noiseScaleOpt,
            noiseScaleWOpt,
            lengthScaleOpt,
            ruleFstsOpt,
            ruleFarsOpt,
            maxNumSentencesOpt,
            silenceScaleOpt,
            providerOpt
        );

        if (!result.success) {
            NSString *errorMsg = @"Failed to update TTS params";
            RCTLogError(@"%@", errorMsg);
            reject(@"TTS_UPDATE_ERROR", errorMsg, nil);
            return;
        }

        inst->noiseScale = nextNoiseScale ? [nextNoiseScale copy] : nil;
        inst->noiseScaleW = nextNoiseScaleW ? [nextNoiseScaleW copy] : nil;
        inst->lengthScale = nextLengthScale ? [nextLengthScale copy] : nil;

        NSMutableArray *detectedModelsArray = [NSMutableArray array];
        for (const auto& model : result.detectedModels) {
            NSDictionary *modelDict = @{
                @"type": [NSString stringWithUTF8String:model.type.c_str()],
                @"modelDir": [NSString stringWithUTF8String:model.modelDir.c_str()]
            };
            [detectedModelsArray addObject:modelDict];
        }

        NSDictionary *resultDict = @{
            @"success": @YES,
            @"detectedModels": detectedModelsArray
        };

        resolve(resultDict);
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception during TTS update: %@", exception.reason];
        RCTLogError(@"%@", errorMsg);
        reject(@"TTS_UPDATE_ERROR", errorMsg, nil);
    }
}

- (void)generateTts:(NSString *)instanceId
              text:(NSString *)text
            options:(NSDictionary *)options
       resolve:(RCTPromiseResolveBlock)resolve
       reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(@"TTS_GENERATE_ERROR", @"instanceId is required", nil);
        return;
    }
    double sid = 0;
    double speed = 1.0;
    if (options != nil) {
        if (options[@"sid"] != nil) sid = [options[@"sid"] doubleValue];
        if (options[@"speed"] != nil) speed = [options[@"speed"] doubleValue];
    }
    std::string instanceIdStr = [instanceId UTF8String];
    std::lock_guard<std::mutex> lock(g_tts_mutex);
    auto it = g_tts_instances.find(instanceIdStr);
    if (it == g_tts_instances.end() || it->second->wrapper == nullptr || !it->second->wrapper->isInitialized()) {
        reject(@"TTS_NOT_INITIALIZED", @"TTS not initialized. Call initializeTts() first.", nil);
        return;
    }
    sherpaonnx::TtsWrapper *wrapper = it->second->wrapper.get();
    @try {
        std::string textStr = [text UTF8String];

        auto result = wrapper->generate(
            textStr,
            static_cast<int32_t>(sid),
            static_cast<float>(speed)
        );

        if (result.samples.empty() || result.sampleRate == 0) {
            NSString *errorMsg = @"Failed to generate speech or result is empty";
            RCTLogError(@"%@", errorMsg);
            reject(@"TTS_GENERATE_ERROR", errorMsg, nil);
            return;
        }

        NSMutableArray *samplesArray = [NSMutableArray arrayWithCapacity:result.samples.size()];
        for (float sample : result.samples) {
            [samplesArray addObject:@(sample)];
        }

        NSDictionary *resultDict = @{
            @"samples": samplesArray,
            @"sampleRate": @(result.sampleRate)
        };

        RCTLogInfo(@"TTS: Generated %lu samples at %d Hz",
                   (unsigned long)result.samples.size(), result.sampleRate);

        resolve(resultDict);
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception during TTS generation: %@", exception.reason];
        RCTLogError(@"%@", errorMsg);
        reject(@"TTS_GENERATE_ERROR", errorMsg, nil);
    }
}

- (void)generateTtsWithTimestamps:(NSString *)instanceId
                            text:(NSString *)text
                          options:(NSDictionary *)options
                     resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(@"TTS_GENERATE_ERROR", @"instanceId is required", nil);
        return;
    }
    double sid = 0;
    double speed = 1.0;
    if (options != nil) {
        if (options[@"sid"] != nil) sid = [options[@"sid"] doubleValue];
        if (options[@"speed"] != nil) speed = [options[@"speed"] doubleValue];
    }
    std::string instanceIdStr = [instanceId UTF8String];
    std::lock_guard<std::mutex> lock(g_tts_mutex);
    auto it = g_tts_instances.find(instanceIdStr);
    if (it == g_tts_instances.end() || it->second->wrapper == nullptr || !it->second->wrapper->isInitialized()) {
        reject(@"TTS_NOT_INITIALIZED", @"TTS not initialized. Call initializeTts() first.", nil);
        return;
    }
    sherpaonnx::TtsWrapper *wrapper = it->second->wrapper.get();
    @try {
        std::string textStr = [text UTF8String];

        auto result = wrapper->generate(
            textStr,
            static_cast<int32_t>(sid),
            static_cast<float>(speed)
        );

        if (result.samples.empty() || result.sampleRate == 0) {
            NSString *errorMsg = @"Failed to generate speech or result is empty";
            RCTLogError(@"%@", errorMsg);
            reject(@"TTS_GENERATE_ERROR", errorMsg, nil);
            return;
        }

        NSMutableArray *samplesArray = [NSMutableArray arrayWithCapacity:result.samples.size()];
        for (float sample : result.samples) {
            [samplesArray addObject:@(sample)];
        }

        std::vector<std::string> tokens = SplitTtsTokens(textStr);
        NSMutableArray *subtitlesArray = [NSMutableArray array];
        if (!tokens.empty()) {
            double totalSeconds = static_cast<double>(result.samples.size()) /
                                  static_cast<double>(result.sampleRate);
            double perToken = totalSeconds / static_cast<double>(tokens.size());

            for (size_t i = 0; i < tokens.size(); ++i) {
                double start = perToken * static_cast<double>(i);
                double end = perToken * static_cast<double>(i + 1);
                NSDictionary *item = @{
                    @"text": [NSString stringWithUTF8String:tokens[i].c_str()],
                    @"start": @(start),
                    @"end": @(end)
                };
                [subtitlesArray addObject:item];
            }
        }

        NSDictionary *resultDict = @{
            @"samples": samplesArray,
            @"sampleRate": @(result.sampleRate),
            @"subtitles": subtitlesArray,
            @"estimated": @YES
        };

        resolve(resultDict);
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception during TTS generation: %@", exception.reason];
        RCTLogError(@"%@", errorMsg);
        reject(@"TTS_GENERATE_ERROR", errorMsg, nil);
    }
}

- (void)generateTtsStream:(NSString *)instanceId
                requestId:(NSString *)requestId
                     text:(NSString *)text
                  options:(NSDictionary *)options
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(@"TTS_STREAM_ERROR", @"instanceId is required", nil);
        return;
    }
    double sid = 0;
    double speed = 1.0;
    if (options != nil) {
        if (options[@"sid"] != nil) sid = [options[@"sid"] doubleValue];
        if (options[@"speed"] != nil) speed = [options[@"speed"] doubleValue];
    }
    std::string instanceIdStr = [instanceId UTF8String];
    std::shared_ptr<TtsInstanceState> instRef;
    {
        std::lock_guard<std::mutex> lock(g_tts_mutex);
        auto it = g_tts_instances.find(instanceIdStr);
        if (it == g_tts_instances.end() || it->second->wrapper == nullptr || !it->second->wrapper->isInitialized()) {
            reject(@"TTS_NOT_INITIALIZED", @"TTS not initialized. Call initializeTts() first.", nil);
            return;
        }
        instRef = it->second; // shared_ptr copy keeps TtsInstanceState alive during streaming
        if (instRef->streamRunning.load()) {
            reject(@"TTS_STREAM_ERROR", @"TTS streaming already in progress", nil);
            return;
        }
        instRef->streamCancelled.store(false);
        instRef->streamRunning.store(true);
    }

    std::string textStr = [text UTF8String];
    int32_t sampleRate = instRef->wrapper->getSampleRate();
    NSString *instanceIdCopy = [instanceId copy];
    NSString *requestIdCopy = (requestId != nil && [requestId length] > 0) ? [requestId copy] : nil;

    __weak SherpaOnnx *weakSelf = self;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        bool success = false;
        @try {
            success = instRef->wrapper->generateStream(
                textStr,
                static_cast<int32_t>(sid),
                static_cast<float>(speed),
                [weakSelf, sampleRate, instanceIdCopy, requestIdCopy, instRef](const float *samples, int32_t numSamples, float progress) -> int32_t {
                    if (instRef->streamCancelled.load()) {
                        return 0;
                    }

                    NSMutableArray *samplesArray = [NSMutableArray arrayWithCapacity:numSamples];
                    for (int32_t i = 0; i < numSamples; i++) {
                        [samplesArray addObject:@(samples[i])];
                    }

                    NSMutableDictionary *payload = [NSMutableDictionary dictionaryWithDictionary:@{
                        @"instanceId": instanceIdCopy,
                        @"samples": samplesArray,
                        @"sampleRate": @(sampleRate),
                        @"progress": @(progress),
                        @"isFinal": @NO
                    }];
                    if (requestIdCopy != nil) payload[@"requestId"] = requestIdCopy;

                    dispatch_async(dispatch_get_main_queue(), ^{
                        if (weakSelf) {
                            [weakSelf sendEventWithName:@"ttsStreamChunk" body:payload];
                        }
                    });

                    return instRef->streamCancelled.load() ? 0 : 1;
                }
            );
        } @catch (NSException *exception) {
            NSString *errorMsg = [NSString stringWithFormat:@"TTS streaming failed: %@", exception.reason];
            NSMutableDictionary *errPayload = [NSMutableDictionary dictionaryWithDictionary:@{ @"instanceId": instanceIdCopy, @"message": errorMsg }];
            if (requestIdCopy != nil) errPayload[@"requestId"] = requestIdCopy;
            dispatch_async(dispatch_get_main_queue(), ^{
                if (weakSelf) {
                    [weakSelf sendEventWithName:@"ttsStreamError" body:errPayload];
                }
            });
        }

        bool cancelled = instRef->streamCancelled.load();
        if (!success && !cancelled) {
            NSMutableDictionary *errPayload = [NSMutableDictionary dictionaryWithDictionary:@{ @"instanceId": instanceIdCopy, @"message": @"TTS streaming generation failed" }];
            if (requestIdCopy != nil) errPayload[@"requestId"] = requestIdCopy;
            dispatch_async(dispatch_get_main_queue(), ^{
                if (weakSelf) {
                    [weakSelf sendEventWithName:@"ttsStreamError" body:errPayload];
                }
            });
        }

        // Emit final chunk (empty, progress 1, isFinal YES) when not cancelled, matching Android behaviour
        if (!cancelled) {
            NSMutableDictionary *finalPayload = [NSMutableDictionary dictionaryWithDictionary:@{
                @"instanceId": instanceIdCopy,
                @"samples": @[],
                @"sampleRate": @(sampleRate),
                @"progress": @1.0f,
                @"isFinal": @YES
            }];
            if (requestIdCopy != nil) finalPayload[@"requestId"] = requestIdCopy;
            dispatch_async(dispatch_get_main_queue(), ^{
                if (weakSelf) {
                    [weakSelf sendEventWithName:@"ttsStreamChunk" body:finalPayload];
                }
            });
        }

        NSMutableDictionary *endPayload = [NSMutableDictionary dictionaryWithDictionary:@{ @"instanceId": instanceIdCopy, @"cancelled": @(cancelled) }];
        if (requestIdCopy != nil) endPayload[@"requestId"] = requestIdCopy;
        dispatch_async(dispatch_get_main_queue(), ^{
            if (weakSelf) {
                [weakSelf sendEventWithName:@"ttsStreamEnd" body:endPayload];
            }
        });

        instRef->streamRunning.store(false);
        {
            std::lock_guard<std::mutex> lock(g_tts_mutex);
            g_tts_stream_cv.notify_all();
        }
    });

    resolve(nil);
}

- (void)cancelTtsStream:(NSString *)instanceId
           resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        resolve(nil);
        return;
    }
    std::string instanceIdStr = [instanceId UTF8String];
    std::lock_guard<std::mutex> lock(g_tts_mutex);
    auto it = g_tts_instances.find(instanceIdStr);
    if (it != g_tts_instances.end()) {
        it->second->streamCancelled.store(true);
    }
    resolve(nil);
}

- (void)startTtsPcmPlayer:(NSString *)instanceId
               sampleRate:(double)sampleRate
                 channels:(double)channels
             resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(@"TTS_PCM_ERROR", @"instanceId is required", nil);
        return;
    }
    std::string instanceIdStr = [instanceId UTF8String];
    dispatch_async(dispatch_get_main_queue(), ^{
        @try {
            TtsInstanceState *inst = nullptr;
            NSError *startError = nil;
            NSString *errorMsg = nil;
            AVAudioSession *session = nil;
            {
                std::lock_guard<std::mutex> lock(g_tts_mutex);
                auto it = g_tts_instances.find(instanceIdStr);
                if (it == g_tts_instances.end()) {
                    errorMsg = @"TTS instance not found";
                    goto out_start;
                }
                inst = it->second.get();
                if (channels != 1.0) {
                    errorMsg = @"PCM playback supports mono only";
                    goto out_start;
                }
                if (inst->player != nil) [inst->player stop];
                if (inst->engine != nil) {
                    [inst->engine stop];
                    [inst->engine reset];
                }
                inst->player = nil;
                inst->engine = nil;
                inst->format = nil;
            }

            session = [AVAudioSession sharedInstance];
            [session setCategory:AVAudioSessionCategoryPlayback error:nil];
            [session setActive:YES error:nil];

            {
                std::lock_guard<std::mutex> lock(g_tts_mutex);
                auto it = g_tts_instances.find(instanceIdStr);
                if (it == g_tts_instances.end()) {
                    errorMsg = @"TTS instance not found";
                    goto out_start;
                }
                inst = it->second.get();
                inst->engine = [[AVAudioEngine alloc] init];
                inst->player = [[AVAudioPlayerNode alloc] init];
                inst->format = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:sampleRate channels:1];

                [inst->engine attachNode:inst->player];
                [inst->engine connect:inst->player to:inst->engine.mainMixerNode format:inst->format];

                if (![inst->engine startAndReturnError:&startError]) {
                    errorMsg = [NSString stringWithFormat:@"Failed to start audio engine: %@", startError.localizedDescription];
                    goto out_start;
                }
                [inst->player play];
            }
        out_start:
            if (errorMsg != nil) {
                if (startError) {
                    reject(@"TTS_PCM_ERROR", errorMsg, startError);
                } else {
                    reject(@"TTS_PCM_ERROR", errorMsg, nil);
                }
            } else {
                resolve(nil);
            }
        } @catch (NSException *exception) {
            NSString *errorMsg = [NSString stringWithFormat:@"Failed to start PCM player: %@", exception.reason];
            reject(@"TTS_PCM_ERROR", errorMsg, nil);
        }
    });
}

- (void)writeTtsPcmChunk:(NSString *)instanceId
                 samples:(NSArray<NSNumber *> *)samples
            resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(@"TTS_PCM_ERROR", @"instanceId is required", nil);
        return;
    }
    std::string instanceIdStr = [instanceId UTF8String];
    std::lock_guard<std::mutex> lock(g_tts_mutex);
    auto it = g_tts_instances.find(instanceIdStr);
    if (it == g_tts_instances.end() || it->second->engine == nil || it->second->player == nil || it->second->format == nil) {
        reject(@"TTS_PCM_ERROR", @"PCM player not initialized", nil);
        return;
    }
    TtsInstanceState *inst = it->second.get();
    @try {
        AVAudioFrameCount frameCount = (AVAudioFrameCount)[samples count];
        AVAudioPCMBuffer *buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:inst->format frameCapacity:frameCount];
        buffer.frameLength = frameCount;

        float *channelData = buffer.floatChannelData[0];
        for (NSUInteger i = 0; i < [samples count]; i++) {
            channelData[i] = [samples[i] floatValue];
        }

        [inst->player scheduleBuffer:buffer completionHandler:nil];
        resolve(nil);
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Failed to write PCM chunk: %@", exception.reason];
        reject(@"TTS_PCM_ERROR", errorMsg, nil);
    }
}

- (void)stopTtsPcmPlayer:(NSString *)instanceId
            resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        resolve(nil);
        return;
    }
    std::string instanceIdStr = [instanceId UTF8String];
    dispatch_async(dispatch_get_main_queue(), ^{
        @try {
            std::lock_guard<std::mutex> lock(g_tts_mutex);
            auto it = g_tts_instances.find(instanceIdStr);
            if (it != g_tts_instances.end()) {
                TtsInstanceState *inst = it->second.get();
                if (inst->player != nil) {
                    [inst->player stop];
                }
                if (inst->engine != nil) {
                    [inst->engine stop];
                    [inst->engine reset];
                }
                inst->player = nil;
                inst->engine = nil;
                inst->format = nil;
            }
            resolve(nil);
        } @catch (NSException *exception) {
            NSString *errorMsg = [NSString stringWithFormat:@"Failed to stop PCM player: %@", exception.reason];
            reject(@"TTS_PCM_ERROR", errorMsg, nil);
        }
    });
}

- (void)getTtsSampleRate:(NSString *)instanceId
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

- (void)getTtsNumSpeakers:(NSString *)instanceId
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

- (void)unloadTts:(NSString *)instanceId
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

- (void)saveTtsAudioToFile:(NSArray<NSNumber *> *)samples
                sampleRate:(double)sampleRate
                  filePath:(NSString *)filePath
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
    @try {
        std::vector<float> samplesVec;
        samplesVec.reserve([samples count]);
        for (NSNumber *num in samples) {
            samplesVec.push_back([num floatValue]);
        }

        std::string filePathStr = std::string([filePath UTF8String]);

        bool success = sherpaonnx::TtsWrapper::saveToWavFile(
            samplesVec,
            static_cast<int32_t>(sampleRate),
            filePathStr
        );

        if (success) {
            resolve(filePath);
        } else {
            reject(@"TTS_SAVE_ERROR", @"Failed to save audio to file", nil);
        }
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception saving TTS audio: %@", exception.reason];
        reject(@"TTS_SAVE_ERROR", errorMsg, nil);
    }
}

- (void)saveTtsAudioToContentUri:(NSArray<NSNumber *> *)samples
                      sampleRate:(double)sampleRate
                    directoryUri:(NSString *)directoryUri
                        filename:(NSString *)filename
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
    @try {
        if ([directoryUri hasPrefix:@"content://"]) {
            reject(@"TTS_SAVE_ERROR", @"Content URIs are not supported on iOS", nil);
            return;
        }
        std::vector<float> samplesVec;
        samplesVec.reserve([samples count]);
        for (NSNumber *num in samples) {
            samplesVec.push_back([num floatValue]);
        }
        NSString *dirPath = [directoryUri hasPrefix:@"file://"]
            ? [[NSURL URLWithString:directoryUri] path]
            : directoryUri;
        NSString *filePath = [dirPath stringByAppendingPathComponent:filename];
        std::string filePathStr = std::string([filePath UTF8String]);
        bool success = sherpaonnx::TtsWrapper::saveToWavFile(
            samplesVec,
            static_cast<int32_t>(sampleRate),
            filePathStr
        );
        if (success) {
            resolve(filePath);
        } else {
            reject(@"TTS_SAVE_ERROR", @"Failed to save audio to file", nil);
        }
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception saving TTS audio: %@", exception.reason];
        reject(@"TTS_SAVE_ERROR", errorMsg, nil);
    }
}

- (void)copyTtsContentUriToCache:(NSString *)fileUri
                        filename:(NSString *)filename
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
    @try {
        if ([fileUri hasPrefix:@"content://"]) {
            reject(@"TTS_SAVE_ERROR", @"Content URIs are not supported on iOS", nil);
            return;
        }
        NSString *srcPath = [fileUri hasPrefix:@"file://"]
            ? [[NSURL URLWithString:fileUri] path]
            : fileUri;
        NSFileManager *fm = [NSFileManager defaultManager];
        if (![fm fileExistsAtPath:srcPath]) {
            reject(@"TTS_SAVE_ERROR", @"Source file does not exist", nil);
            return;
        }
        NSArray *caches = NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES);
        NSString *cacheDir = caches.firstObject;
        NSString *destPath = [[cacheDir stringByAppendingPathComponent:@"sherpa_tts"] stringByAppendingPathComponent:filename];
        NSError *err = nil;
        [fm createDirectoryAtPath:[destPath stringByDeletingLastPathComponent] withIntermediateDirectories:YES attributes:nil error:&err];
        if (err) {
            reject(@"TTS_SAVE_ERROR", err.localizedDescription, err);
            return;
        }
        if ([fm fileExistsAtPath:destPath]) {
            [fm removeItemAtPath:destPath error:nil];
        }
        BOOL ok = [fm copyItemAtPath:srcPath toPath:destPath error:&err];
        if (!ok || err) {
            reject(@"TTS_SAVE_ERROR", err ? err.localizedDescription : @"Copy failed", err);
            return;
        }
        resolve(destPath);
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception copying file: %@", exception.reason];
        reject(@"TTS_SAVE_ERROR", errorMsg, nil);
    }
}

- (void)saveTtsTextToContentUri:(NSString *)text
                 directoryUri:(NSString *)directoryUri
                     filename:(NSString *)filename
                     mimeType:(NSString *)mimeType
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
    @try {
        if ([directoryUri hasPrefix:@"content://"]) {
            reject(@"TTS_SAVE_ERROR", @"Content URIs are not supported on iOS", nil);
            return;
        }

        NSURL *directoryUrl = nil;
        if ([directoryUri hasPrefix:@"file://"]) {
            directoryUrl = [NSURL URLWithString:directoryUri];
        } else {
            directoryUrl = [NSURL fileURLWithPath:directoryUri];
        }

        if (!directoryUrl) {
            reject(@"TTS_SAVE_ERROR", @"Invalid directory URL", nil);
            return;
        }

        NSString *directoryPath = [directoryUrl path];
        NSString *filePath = [directoryPath stringByAppendingPathComponent:filename];

        NSError *writeError = nil;
        BOOL success = [text writeToFile:filePath
                               atomically:YES
                                 encoding:NSUTF8StringEncoding
                                    error:&writeError];

        if (!success || writeError) {
            reject(@"TTS_SAVE_ERROR", @"Failed to save text to file", writeError);
            return;
        }

        resolve(filePath);
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception saving text file: %@", exception.reason];
        reject(@"TTS_SAVE_ERROR", errorMsg, nil);
    }
}

- (void)shareTtsAudio:(NSString *)fileUri
            mimeType:(NSString *)mimeType
         resolve:(RCTPromiseResolveBlock)resolve
         reject:(RCTPromiseRejectBlock)reject
{
    @try {
        NSURL *url = nil;
        if ([fileUri hasPrefix:@"file://"] || [fileUri hasPrefix:@"content://"]) {
            url = [NSURL URLWithString:fileUri];
        } else {
            url = [NSURL fileURLWithPath:fileUri];
        }

        if (!url) {
            reject(@"TTS_SHARE_ERROR", @"Invalid file URL", nil);
            return;
        }

        dispatch_async(dispatch_get_main_queue(), ^{
            UIViewController *controller = RCTPresentedViewController();
            if (!controller) {
                reject(@"TTS_SHARE_ERROR", @"No active view controller", nil);
                return;
            }

            UIActivityViewController *activity =
                [[UIActivityViewController alloc] initWithActivityItems:@[url]
                                                  applicationActivities:nil];
            [controller presentViewController:activity animated:YES completion:nil];
            resolve(nil);
        });
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Failed to share audio: %@", exception.reason];
        reject(@"TTS_SHARE_ERROR", errorMsg, nil);
    }
}

@end
