#import "SherpaOnnx.h"
#import <React/RCTLog.h>

#include "sherpa-onnx-stt-wrapper.h"
#include <memory>
#include <optional>
#include <string>
#include <vector>

// Global STT wrapper instance
static std::unique_ptr<sherpaonnx::SttWrapper> g_stt_wrapper = nullptr;

static NSDictionary *sttResultToDict(const sherpaonnx::SttRecognitionResult& r) {
    NSMutableArray *tokens = [NSMutableArray arrayWithCapacity:r.tokens.size()];
    for (const auto& t : r.tokens) {
        [tokens addObject:[NSString stringWithUTF8String:t.c_str()]];
    }
    NSMutableArray *timestamps = [NSMutableArray arrayWithCapacity:r.timestamps.size()];
    for (float ts : r.timestamps) {
        [timestamps addObject:@(ts)];
    }
    NSMutableArray *durations = [NSMutableArray arrayWithCapacity:r.durations.size()];
    for (float d : r.durations) {
        [durations addObject:@(d)];
    }
    return @{
        @"text": [NSString stringWithUTF8String:r.text.c_str()] ?: @"",
        @"tokens": tokens,
        @"timestamps": timestamps,
        @"lang": [NSString stringWithUTF8String:r.lang.c_str()] ?: @"",
        @"emotion": [NSString stringWithUTF8String:r.emotion.c_str()] ?: @"",
        @"event": [NSString stringWithUTF8String:r.event.c_str()] ?: @"",
        @"durations": durations
    };
}

@implementation SherpaOnnx (STT)

- (void)initializeStt:(NSString *)modelDir
          preferInt8:(NSNumber *)preferInt8
           modelType:(NSString *)modelType
               debug:(NSNumber *)debug
        hotwordsFile:(NSString *)hotwordsFile
       hotwordsScore:(NSNumber *)hotwordsScore
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
    RCTLogInfo(@"Initializing sherpa-onnx with modelDir: %@", modelDir);

    @try {
        if (g_stt_wrapper == nullptr) {
            g_stt_wrapper = std::make_unique<sherpaonnx::SttWrapper>();
        }

        std::string modelDirStr = [modelDir UTF8String];

        std::optional<bool> preferInt8Opt = std::nullopt;
        if (preferInt8 != nil) {
            preferInt8Opt = [preferInt8 boolValue];
        }

        std::optional<std::string> modelTypeOpt = std::nullopt;
        if (modelType != nil && [modelType length] > 0) {
            modelTypeOpt = [modelType UTF8String];
        }

        bool debugVal = (debug != nil && [debug boolValue]);

        std::optional<std::string> hotwordsFileOpt = std::nullopt;
        if (hotwordsFile != nil && [hotwordsFile length] > 0) {
            hotwordsFileOpt = [hotwordsFile UTF8String];
        }

        std::optional<float> hotwordsScoreOpt = std::nullopt;
        if (hotwordsScore != nil) {
            hotwordsScoreOpt = [hotwordsScore floatValue];
        }

        sherpaonnx::SttInitializeResult result = g_stt_wrapper->initialize(
            modelDirStr, preferInt8Opt, modelTypeOpt, debugVal, hotwordsFileOpt, hotwordsScoreOpt);

        if (result.success) {
            RCTLogInfo(@"Sherpa-onnx initialized successfully");

            // Create result dictionary with detected models
            NSMutableDictionary *resultDict = [NSMutableDictionary dictionary];
            resultDict[@"success"] = @YES;

            NSMutableArray *detectedModelsArray = [NSMutableArray array];
            for (const auto& model : result.detectedModels) {
                NSMutableDictionary *modelDict = [NSMutableDictionary dictionary];
                modelDict[@"type"] = [NSString stringWithUTF8String:model.type.c_str()];
                modelDict[@"modelDir"] = [NSString stringWithUTF8String:model.modelDir.c_str()];
                [detectedModelsArray addObject:modelDict];
            }
            resultDict[@"detectedModels"] = detectedModelsArray;

            resolve(resultDict);
        } else {
            NSString *errorMsg = [NSString stringWithFormat:@"Failed to initialize sherpa-onnx with model directory: %@", modelDir];
            RCTLogError(@"%@", errorMsg);
            reject(@"INIT_ERROR", errorMsg, nil);
        }
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception during initialization: %@", exception.reason];
        RCTLogError(@"%@", errorMsg);
        reject(@"INIT_ERROR", errorMsg, nil);
    }
}

- (void)transcribeFile:(NSString *)filePath
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
    if (g_stt_wrapper == nullptr || !g_stt_wrapper->isInitialized()) {
        NSString *errorMsg = @"STT not initialized. Call initializeStt first.";
        RCTLogError(@"Transcribe error: %@", errorMsg);
        reject(@"TRANSCRIBE_ERROR", errorMsg, nil);
        return;
    }

    try {
        std::string filePathStr = [filePath UTF8String];
        sherpaonnx::SttRecognitionResult result = g_stt_wrapper->transcribeFile(filePathStr);
        resolve(sttResultToDict(result));
    } catch (const std::exception& e) {
        NSString *errorMsg = e.what() ? [NSString stringWithUTF8String:e.what()] : @"Recognition failed.";
        if (!errorMsg) errorMsg = @"Recognition failed.";
        RCTLogError(@"Transcribe error: %@", errorMsg);
        reject(@"TRANSCRIBE_ERROR", errorMsg, nil);
    } catch (...) {
        NSString *errorMsg = @"Unknown error during transcription";
        RCTLogError(@"Transcribe error: %@", errorMsg);
        reject(@"TRANSCRIBE_ERROR", errorMsg, nil);
    }
}

- (void)transcribeSamples:(NSArray<NSNumber *> *)samples
              sampleRate:(double)sampleRate
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
    if (g_stt_wrapper == nullptr || !g_stt_wrapper->isInitialized()) {
        NSString *errorMsg = @"STT not initialized. Call initializeStt first.";
        RCTLogError(@"TranscribeSamples error: %@", errorMsg);
        reject(@"TRANSCRIBE_ERROR", errorMsg, nil);
        return;
    }

    try {
        std::vector<float> floatSamples;
        floatSamples.reserve([samples count]);
        for (NSNumber *n in samples) {
            floatSamples.push_back([n floatValue]);
        }
        sherpaonnx::SttRecognitionResult result = g_stt_wrapper->transcribeSamples(floatSamples, static_cast<int32_t>(sampleRate));
        resolve(sttResultToDict(result));
    } catch (const std::exception& e) {
        NSString *errorMsg = e.what() ? [NSString stringWithUTF8String:e.what()] : @"Recognition failed.";
        if (!errorMsg) errorMsg = @"Recognition failed.";
        RCTLogError(@"TranscribeSamples error: %@", errorMsg);
        reject(@"TRANSCRIBE_ERROR", errorMsg, nil);
    } catch (...) {
        NSString *errorMsg = @"Unknown error during transcription";
        RCTLogError(@"TranscribeSamples error: %@", errorMsg);
        reject(@"TRANSCRIBE_ERROR", errorMsg, nil);
    }
}

- (void)setSttConfig:(NSDictionary *)options
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
    if (g_stt_wrapper == nullptr || !g_stt_wrapper->isInitialized()) {
        NSString *errorMsg = @"STT not initialized. Call initializeStt first.";
        RCTLogError(@"setSttConfig error: %@", errorMsg);
        reject(@"CONFIG_ERROR", errorMsg, nil);
        return;
    }

    @try {
        sherpaonnx::SttRuntimeConfigOptions opts;
        if (options[@"decodingMethod"] != nil) {
            opts.decoding_method = [options[@"decodingMethod"] isKindOfClass:[NSString class]]
                ? std::optional<std::string>([(NSString *)options[@"decodingMethod"] UTF8String])
                : std::nullopt;
        }
        if (options[@"maxActivePaths"] != nil) {
            NSNumber *n = options[@"maxActivePaths"];
            if ([n isKindOfClass:[NSNumber class]]) opts.max_active_paths = [n intValue];
        }
        if (options[@"hotwordsFile"] != nil && [options[@"hotwordsFile"] isKindOfClass:[NSString class]]) {
            opts.hotwords_file = [(NSString *)options[@"hotwordsFile"] UTF8String];
        }
        if (options[@"hotwordsScore"] != nil) {
            NSNumber *n = options[@"hotwordsScore"];
            if ([n isKindOfClass:[NSNumber class]]) opts.hotwords_score = [n floatValue];
        }
        if (options[@"blankPenalty"] != nil) {
            NSNumber *n = options[@"blankPenalty"];
            if ([n isKindOfClass:[NSNumber class]]) opts.blank_penalty = [n floatValue];
        }
        g_stt_wrapper->setConfig(opts);
        resolve(nil);
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception in setSttConfig: %@", exception.reason];
        RCTLogError(@"%@", errorMsg);
        reject(@"CONFIG_ERROR", errorMsg, nil);
    }
}

- (void)unloadStt:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
    @try {
        if (g_stt_wrapper != nullptr) {
            g_stt_wrapper->release();
            g_stt_wrapper.reset();
            g_stt_wrapper = nullptr;
        }
        RCTLogInfo(@"Sherpa-onnx resources released");
        resolve(nil);
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception during cleanup: %@", exception.reason];
        RCTLogError(@"%@", errorMsg);
        reject(@"CLEANUP_ERROR", errorMsg, nil);
    }
}

@end
