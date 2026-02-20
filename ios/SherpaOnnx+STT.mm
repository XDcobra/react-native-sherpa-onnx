#import "SherpaOnnx.h"
#import <React/RCTLog.h>

#include "sherpa-onnx-stt-wrapper.h"
#include "sherpa-onnx-model-detect.h"
#include <memory>
#include <optional>
#include <string>
#include <vector>

static NSString *sttModelKindToNSString(sherpaonnx::SttModelKind kind) {
    using K = sherpaonnx::SttModelKind;
    switch (kind) {
        case K::kTransducer: return @"transducer";
        case K::kNemoTransducer: return @"nemo_transducer";
        case K::kParaformer: return @"paraformer";
        case K::kNemoCtc: return @"nemo_ctc";
        case K::kWenetCtc: return @"wenet_ctc";
        case K::kSenseVoice: return @"sense_voice";
        case K::kZipformerCtc: return @"zipformer_ctc";
        case K::kWhisper: return @"whisper";
        case K::kFunAsrNano: return @"funasr_nano";
        case K::kFireRedAsr: return @"fire_red_asr";
        case K::kMoonshine: return @"moonshine";
        case K::kDolphin: return @"dolphin";
        case K::kCanary: return @"canary";
        case K::kOmnilingual: return @"omnilingual";
        case K::kMedAsr: return @"medasr";
        case K::kTeleSpeechCtc: return @"telespeech_ctc";
        default: return @"unknown";
    }
}

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
          numThreads:(NSNumber *)numThreads
            provider:(NSString *)provider
            ruleFsts:(NSString *)ruleFsts
            ruleFars:(NSString *)ruleFars
              dither:(NSNumber *)dither
         modelOptions:(NSDictionary *)modelOptions
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

        std::optional<int32_t> numThreadsOpt = std::nullopt;
        if (numThreads != nil) {
            numThreadsOpt = [numThreads intValue];
        }

        std::optional<std::string> providerOpt = std::nullopt;
        if (provider != nil && [provider length] > 0) {
            providerOpt = [provider UTF8String];
        }

        std::optional<std::string> ruleFstsOpt = std::nullopt;
        if (ruleFsts != nil && [ruleFsts length] > 0) {
            ruleFstsOpt = [ruleFsts UTF8String];
        }

        std::optional<std::string> ruleFarsOpt = std::nullopt;
        if (ruleFars != nil && [ruleFars length] > 0) {
            ruleFarsOpt = [ruleFars UTF8String];
        }

        std::optional<float> ditherOpt = std::nullopt;
        if (dither != nil) {
            ditherOpt = [dither floatValue];
        }

        // Parse model-specific options (only the block for the loaded model type is applied in C++).
        sherpaonnx::SttWhisperOptions whisperOpts;
        sherpaonnx::SttSenseVoiceOptions senseVoiceOpts;
        sherpaonnx::SttCanaryOptions canaryOpts;
        sherpaonnx::SttFunAsrNanoOptions funasrNanoOpts;
        const sherpaonnx::SttWhisperOptions *whisperOptsPtr = nullptr;
        const sherpaonnx::SttSenseVoiceOptions *senseVoiceOptsPtr = nullptr;
        const sherpaonnx::SttCanaryOptions *canaryOptsPtr = nullptr;
        const sherpaonnx::SttFunAsrNanoOptions *funasrNanoOptsPtr = nullptr;
        if (modelOptions != nil && [modelOptions isKindOfClass:[NSDictionary class]]) {
            NSDictionary *w = modelOptions[@"whisper"];
            if ([w isKindOfClass:[NSDictionary class]]) {
                if (w[@"language"] != nil) whisperOpts.language = std::string([(NSString *)w[@"language"] UTF8String]);
                if (w[@"task"] != nil) whisperOpts.task = std::string([(NSString *)w[@"task"] UTF8String]);
                if (w[@"tailPaddings"] != nil) whisperOpts.tail_paddings = [(NSNumber *)w[@"tailPaddings"] intValue];
                whisperOptsPtr = &whisperOpts;
            }
            NSDictionary *sv = modelOptions[@"senseVoice"];
            if ([sv isKindOfClass:[NSDictionary class]]) {
                if (sv[@"language"] != nil) senseVoiceOpts.language = std::string([(NSString *)sv[@"language"] UTF8String]);
                if (sv[@"useItn"] != nil) senseVoiceOpts.use_itn = [(NSNumber *)sv[@"useItn"] boolValue];
                senseVoiceOptsPtr = &senseVoiceOpts;
            }
            NSDictionary *c = modelOptions[@"canary"];
            if ([c isKindOfClass:[NSDictionary class]]) {
                if (c[@"srcLang"] != nil) canaryOpts.src_lang = std::string([(NSString *)c[@"srcLang"] UTF8String]);
                if (c[@"tgtLang"] != nil) canaryOpts.tgt_lang = std::string([(NSString *)c[@"tgtLang"] UTF8String]);
                if (c[@"usePnc"] != nil) canaryOpts.use_pnc = [(NSNumber *)c[@"usePnc"] boolValue];
                canaryOptsPtr = &canaryOpts;
            }
            NSDictionary *fn = modelOptions[@"funasrNano"];
            if ([fn isKindOfClass:[NSDictionary class]]) {
                if (fn[@"systemPrompt"] != nil) funasrNanoOpts.system_prompt = std::string([(NSString *)fn[@"systemPrompt"] UTF8String]);
                if (fn[@"userPrompt"] != nil) funasrNanoOpts.user_prompt = std::string([(NSString *)fn[@"userPrompt"] UTF8String]);
                if (fn[@"maxNewTokens"] != nil) funasrNanoOpts.max_new_tokens = [(NSNumber *)fn[@"maxNewTokens"] intValue];
                if (fn[@"temperature"] != nil) funasrNanoOpts.temperature = [(NSNumber *)fn[@"temperature"] floatValue];
                if (fn[@"topP"] != nil) funasrNanoOpts.top_p = [(NSNumber *)fn[@"topP"] floatValue];
                if (fn[@"seed"] != nil) funasrNanoOpts.seed = [(NSNumber *)fn[@"seed"] intValue];
                if (fn[@"language"] != nil) funasrNanoOpts.language = std::string([(NSString *)fn[@"language"] UTF8String]);
                if (fn[@"itn"] != nil) funasrNanoOpts.itn = [(NSNumber *)fn[@"itn"] boolValue];
                if (fn[@"hotwords"] != nil) funasrNanoOpts.hotwords = std::string([(NSString *)fn[@"hotwords"] UTF8String]);
                funasrNanoOptsPtr = &funasrNanoOpts;
            }
        }

        sherpaonnx::SttInitializeResult result = g_stt_wrapper->initialize(
            modelDirStr, preferInt8Opt, modelTypeOpt, debugVal, hotwordsFileOpt, hotwordsScoreOpt,
            numThreadsOpt, providerOpt, ruleFstsOpt, ruleFarsOpt, ditherOpt,
            whisperOptsPtr, senseVoiceOptsPtr, canaryOptsPtr, funasrNanoOptsPtr);

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

- (void)detectSttModel:(NSString *)modelDir
           preferInt8:(NSNumber *)preferInt8
            modelType:(NSString *)modelType
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
    RCTLogInfo(@"Detecting STT model in: %@", modelDir);
    @try {
        std::string modelDirStr = [modelDir UTF8String];
        std::optional<bool> preferInt8Opt = std::nullopt;
        if (preferInt8 != nil) {
            preferInt8Opt = [preferInt8 boolValue];
        }
        std::optional<std::string> modelTypeOpt = std::nullopt;
        if (modelType != nil && [modelType length] > 0 && ![modelType isEqualToString:@"auto"]) {
            modelTypeOpt = [modelType UTF8String];
        }
        sherpaonnx::SttDetectResult result = sherpaonnx::DetectSttModel(modelDirStr, preferInt8Opt, modelTypeOpt, false);

        NSMutableDictionary *resultDict = [NSMutableDictionary dictionary];
        resultDict[@"success"] = @(result.ok);
        if (!result.error.empty()) {
            resultDict[@"error"] = [NSString stringWithUTF8String:result.error.c_str()];
        }
        NSMutableArray *detectedModelsArray = [NSMutableArray array];
        for (const auto& model : result.detectedModels) {
            NSMutableDictionary *modelDict = [NSMutableDictionary dictionary];
            modelDict[@"type"] = [NSString stringWithUTF8String:model.type.c_str()];
            modelDict[@"modelDir"] = [NSString stringWithUTF8String:model.modelDir.c_str()];
            [detectedModelsArray addObject:modelDict];
        }
        resultDict[@"detectedModels"] = detectedModelsArray;
        resultDict[@"modelType"] = sttModelKindToNSString(result.selectedKind);
        resolve(resultDict);
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"STT model detection failed: %@", exception.reason];
        RCTLogError(@"%@", errorMsg);
        reject(@"DETECT_ERROR", errorMsg, nil);
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
        if (options[@"ruleFsts"] != nil && [options[@"ruleFsts"] isKindOfClass:[NSString class]]) {
            opts.rule_fsts = [(NSString *)options[@"ruleFsts"] UTF8String];
        }
        if (options[@"ruleFars"] != nil && [options[@"ruleFars"] isKindOfClass:[NSString class]]) {
            opts.rule_fars = [(NSString *)options[@"ruleFars"] UTF8String];
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
