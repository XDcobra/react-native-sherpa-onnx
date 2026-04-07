/**
 * SherpaOnnx+TTSInit.mm — TTS init, detect, catalog hints, param updates.
 */

#import "SherpaOnnx.h"
#import <React/RCTLog.h>
#import <React/RCTUtils.h>

#include "engine/TtsEngineStore.h"
#include "options/TtsGenerationOptionsHelpers.h"
#include "sherpa-onnx-model-detect.h"
#include "native/sherpa-onnx-tts-wrapper.h"

#include <memory>
#include <optional>
#include <string>

@implementation SherpaOnnx (TTSInit)

- (void)so_initializeTts:(NSString *)instanceId
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
            NSString *errorMsg = result.error.empty()
                ? @"Failed to initialize TTS"
                : [NSString stringWithUTF8String:result.error.c_str()];
            RCTLogError(@"TTS init failed: %@", errorMsg);
            reject(@"TTS_INIT_ERROR", errorMsg, nil);
        }
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception during TTS init: %@", exception.reason];
        RCTLogError(@"%@", errorMsg);
        reject(@"TTS_INIT_ERROR", errorMsg, nil);
    }
}

- (void)so_detectTtsModel:(NSString *)modelDir
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
        resultDict[@"modelType"] = TtsModelKindToNSString(result.selectedKind);
        if (!result.lexiconLanguageCandidates.empty()) {
            NSMutableArray *langCandidates = [NSMutableArray array];
            for (const auto& id : result.lexiconLanguageCandidates) {
                [langCandidates addObject:[NSString stringWithUTF8String:id.c_str()]];
            }
            resultDict[@"lexiconLanguageCandidates"] = langCandidates;
        }
        if (!result.detectionSources.empty()) {
            NSMutableArray *sources = [NSMutableArray array];
            for (const auto s : result.detectionSources) {
                [sources addObject:[NSString stringWithUTF8String:sherpaonnx::TtsDetectionSourceToLiteral(s)]];
            }
            resultDict[@"detectionSources"] = sources;
        }
        resolve(resultDict);
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"TTS model detection failed: %@", exception.reason];
        RCTLogError(@"%@", errorMsg);
        reject(@"DETECT_ERROR", errorMsg, nil);
    }
}

- (void)so_batchTtsCatalogHints:(NSArray *)ids
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject
{
    @try {
        if (ids == nil || [ids count] == 0) {
            resolve(@[]);
            return;
        }
        std::vector<std::string> vids;
        vids.reserve([ids count]);
        for (id item in ids) {
            if (![item isKindOfClass:[NSString class]]) {
                vids.emplace_back("");
                continue;
            }
            vids.emplace_back([(NSString *)item UTF8String] ?: "");
        }
        std::vector<sherpaonnx::TtsCatalogHints> batch =
            sherpaonnx::BatchDeriveTtsCatalogHints(vids);
        NSMutableArray *out = [NSMutableArray arrayWithCapacity:batch.size()];
        for (const auto &h : batch) {
            NSMutableArray *langs = [NSMutableArray array];
            for (const auto &l : h.languages) {
                [langs addObject:[NSString stringWithUTF8String:l.c_str()]];
            }
            [out addObject:@{
                @"modelId": [NSString stringWithUTF8String:h.modelId.c_str()],
                @"modelType": [NSString stringWithUTF8String:h.primaryKind.c_str()],
                @"languages": langs,
                @"quantization": [NSString stringWithUTF8String:h.quantization.c_str()],
                @"sizeTier": [NSString stringWithUTF8String:h.sizeTier.c_str()],
            }];
        }
        resolve(out);
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"batchTtsCatalogHints failed: %@", exception.reason];
        RCTLogError(@"%@", errorMsg);
        reject(@"BATCH_TTS_CATALOG_HINTS_ERROR", errorMsg, nil);
    }
}

- (void)so_updateTtsParams:(NSString *)instanceId
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

@end
