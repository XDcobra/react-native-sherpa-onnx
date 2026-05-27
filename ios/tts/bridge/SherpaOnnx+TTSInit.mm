/**
 * SherpaOnnx+TTSInit.mm — TTS init, detect, param updates.
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

static NSString *TtsOptString(NSDictionary *options, NSString *key) {
    id v = options[key];
    if (![v isKindOfClass:[NSString class]]) return nil;
    NSString *s = [(NSString *)v stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    return [s length] > 0 ? s : nil;
}

- (void)so_initializeTts:(NSString *)instanceId
                 options:(NSDictionary *)options
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(@"TTS_INIT_ERROR", @"instanceId is required", nil);
        return;
    }
    if (options == nil || ![options isKindOfClass:[NSDictionary class]]) {
        reject(@"TTS_INIT_ERROR", @"options is required", nil);
        return;
    }
    NSString *modelDir = TtsOptString(options, @"modelDir");
    if (modelDir == nil) {
        reject(@"TTS_INIT_ERROR", @"modelDir is required", nil);
        return;
    }
    NSString *modelType = TtsOptString(options, @"modelType") ?: @"auto";
    double numThreads = options[@"numThreads"] != nil ? [options[@"numThreads"] doubleValue] : 2.0;
    BOOL debug = options[@"debug"] != nil ? [options[@"debug"] boolValue] : NO;
    NSNumber *noiseScale = options[@"noiseScale"];
    NSNumber *noiseScaleW = options[@"noiseScaleW"];
    NSNumber *lengthScale = options[@"lengthScale"];
    NSString *ruleFsts = TtsOptString(options, @"ruleFsts");
    NSString *ruleFars = TtsOptString(options, @"ruleFars");
    NSNumber *maxNumSentences = options[@"maxNumSentences"];
    NSNumber *silenceScale = options[@"silenceScale"];
    NSString *provider = TtsOptString(options, @"provider");
    NSString *lexiconLanguageId = TtsOptString(options, @"lexiconLanguageId");
    NSString *kokoroLang = TtsOptString(options, @"kokoroLang");

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
        if (ruleFsts != nil) {
            ruleFstsOpt = std::string([ruleFsts UTF8String]);
        }
        if (ruleFars != nil) {
            ruleFarsOpt = std::string([ruleFars UTF8String]);
        }
        if (maxNumSentences != nil && [maxNumSentences intValue] >= 1) {
            maxNumSentencesOpt = static_cast<int32_t>([maxNumSentences intValue]);
        }
        if (silenceScale != nil) {
            silenceScaleOpt = [silenceScale floatValue];
        }
        std::optional<std::string> providerOpt = std::nullopt;
        if (provider != nil) {
            providerOpt = std::string([provider UTF8String]);
        }
        std::optional<std::string> lexiconLanguageIdOpt = std::nullopt;
        if (lexiconLanguageId != nil) {
            lexiconLanguageIdOpt = std::string([lexiconLanguageId UTF8String]);
        }
        std::optional<std::string> kokoroLangOpt = std::nullopt;
        if (kokoroLang != nil) {
            kokoroLangOpt = std::string([kokoroLang UTF8String]);
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
            providerOpt,
            lexiconLanguageIdOpt,
            kokoroLangOpt
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
            inst->ruleFsts = ruleFsts ? [ruleFsts copy] : nil;
            inst->ruleFars = ruleFars ? [ruleFars copy] : nil;
            inst->maxNumSentences = (maxNumSentences != nil && [maxNumSentences intValue] >= 1) ? [maxNumSentences copy] : nil;
            inst->silenceScale = silenceScale ? [silenceScale copy] : nil;
            inst->provider = provider ? [provider copy] : nil;

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
                assetName:(NSString *)assetName
                modelType:(NSString *)modelType
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
    RCTLogInfo(@"Detecting TTS model modelDir=%@ assetName=%@", modelDir, assetName);
    @try {
        std::optional<std::string> modelDirOpt;
        if (modelDir != nil && [modelDir length] > 0) {
            modelDirOpt = std::string([modelDir UTF8String]);
        }
        std::optional<std::string> assetNameOpt;
        if (assetName != nil && [assetName length] > 0) {
            assetNameOpt = std::string([assetName UTF8String]);
        }
        std::string modelTypeStr = (modelType != nil && [modelType length] > 0 && ![modelType isEqualToString:@"auto"])
            ? [modelType UTF8String] : "auto";
        sherpaonnx::TtsDetectResult result =
            sherpaonnx::DetectTtsModel(modelDirOpt, assetNameOpt, modelTypeStr);

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
        if (!result.lexiconLanguages.empty()) {
            NSMutableArray *lexiconLanguages = [NSMutableArray array];
            for (const auto& lang : result.lexiconLanguages) {
                [lexiconLanguages addObject:@{
                    @"id": [NSString stringWithUTF8String:lang.languageId.c_str()],
                    @"path": [NSString stringWithUTF8String:lang.path.c_str()]
                }];
            }
            resultDict[@"lexiconLanguages"] = lexiconLanguages;
        }
        if (!result.derivedLanguages.empty()) {
            NSMutableArray *derivedLangs = [NSMutableArray array];
            for (const auto& id : result.derivedLanguages) {
                [derivedLangs addObject:[NSString stringWithUTF8String:id.c_str()]];
            }
            resultDict[@"languages"] = derivedLangs;
        }
        if (!result.quantization.empty()) {
            resultDict[@"quantization"] = [NSString stringWithUTF8String:result.quantization.c_str()];
        }
        if (!result.sizeTier.empty()) {
            resultDict[@"sizeTier"] = [NSString stringWithUTF8String:result.sizeTier.c_str()];
        }
        if (!result.detectionSources.empty()) {
            NSMutableArray *sources = [NSMutableArray array];
            for (const auto s : result.detectionSources) {
                [sources addObject:[NSString stringWithUTF8String:sherpaonnx::DetectionSourceToLiteral(s)]];
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
