/**
 * SherpaOnnx+STT.mm
 *
 * Purpose: STT (speech-to-text) TurboModule methods: initializeStt, releaseStt, runStt, and related.
 * Uses sherpa-onnx-stt-wrapper for native recognition and sherpa-onnx-model-detect for model detection.
 */

#import "../../SherpaOnnx.h"
#import "../../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#import "../../textbuffer/core/SherpaOnnx+TextBufferGlobals.h"
#import <React/RCTLog.h>

#include "../native/sherpa-onnx-stt-wrapper.h"
#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx/c-api/cxx-api.h"
#include <atomic>
#include <memory>
#include <mutex>
#include <optional>
#include <new>
#include <string>
#include <unordered_map>
#include <vector>

// ==================== Error Code Constants ====================
static NSString *const kSttErrInvalidArgument = @"STT_INVALID_ARGUMENT";
static NSString *const kSttErrInitFailed = @"STT_INIT_FAILED";
static NSString *const kSttErrTranscribeFailed = @"STT_TRANSCRIBE_FAILED";
static NSString *const kSttErrConfigFailed = @"STT_CONFIG_FAILED";
static NSString *const kSttErrInstanceNotFound = @"STT_INSTANCE_NOT_FOUND";
static NSString *const kSttErrBufferNotFound = @"STT_BUFFER_NOT_FOUND";
static NSString *const kSttErrBufferKindMismatch = @"STT_BUFFER_KIND_MISMATCH";
static NSString *const kSttErrTextBufferNotFound = @"TEXT_BUFFER_NOT_FOUND";
static NSString *const kSttErrAlreadyPopulated = @"TEXT_ALREADY_POPULATED";
static NSString *const kSttErrOfflineOom = @"OFFLINE_OOM";
static NSString *const kSttErrInternalError = @"STT_INTERNAL_ERROR";
static NSString *const kSttOfflineOomMessage =
    @"Not enough memory for offline speech-to-text. Please use a streaming mode for large inputs. "
    @"Alternatively, use the segmentation engine to process smaller segments with offline models "
    @"(see docs/segmentation-engine.md).";

// ==================== Instance State ====================
struct SttInstanceState {
    std::unique_ptr<sherpaonnx::SttWrapper> wrapper;
};

static std::unordered_map<std::string, std::unique_ptr<SttInstanceState>> g_stt_instances;
static std::mutex g_stt_mutex;

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
        case K::kQwen3Asr: return @"qwen3_asr";
        case K::kCohereTranscribe: return @"cohere_transcribe";
        case K::kFireRedAsr: return @"fire_red_asr";
        case K::kMoonshine: return @"moonshine";
        case K::kMoonshineV2: return @"moonshine_v2";
        case K::kDolphin: return @"dolphin";
        case K::kCanary: return @"canary";
        case K::kOmnilingual: return @"omnilingual";
        case K::kMedAsr: return @"medasr";
        case K::kTeleSpeechCtc: return @"telespeech_ctc";
        default: return @"unknown";
    }
}

@implementation SherpaOnnx (STT)

- (void)initializeStt:(NSString *)instanceId
            modelDir:(NSString *)modelDir
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
        modelingUnit:(NSString *)modelingUnit
             bpeVocab:(NSString *)bpeVocab
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(kSttErrInitFailed, @"instanceId is required", nil);
        return;
    }
    std::string instanceIdStr = [instanceId UTF8String];
    RCTLogInfo(@"Initializing STT instance %@ with modelDir: %@", instanceId, modelDir);

    @try {
        std::lock_guard<std::mutex> lock(g_stt_mutex);
        auto it = g_stt_instances.find(instanceIdStr);
        if (it == g_stt_instances.end()) {
            g_stt_instances[instanceIdStr] = std::make_unique<SttInstanceState>();
        }
        SttInstanceState *inst = g_stt_instances[instanceIdStr].get();
        if (inst->wrapper == nullptr) {
            inst->wrapper = std::make_unique<sherpaonnx::SttWrapper>();
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
        sherpaonnx::SttQwen3AsrOptions qwen3AsrOpts;
        sherpaonnx::SttCohereTranscribeOptions cohereTranscribeOpts;
        const sherpaonnx::SttWhisperOptions *whisperOptsPtr = nullptr;
        const sherpaonnx::SttSenseVoiceOptions *senseVoiceOptsPtr = nullptr;
        const sherpaonnx::SttCanaryOptions *canaryOptsPtr = nullptr;
        const sherpaonnx::SttFunAsrNanoOptions *funasrNanoOptsPtr = nullptr;
        const sherpaonnx::SttQwen3AsrOptions *qwen3AsrOptsPtr = nullptr;
        const sherpaonnx::SttCohereTranscribeOptions *cohereTranscribeOptsPtr = nullptr;
        if (modelOptions != nil && [modelOptions isKindOfClass:[NSDictionary class]]) {
            NSDictionary *w = modelOptions[@"whisper"];
            if ([w isKindOfClass:[NSDictionary class]]) {
                if (w[@"language"] != nil) whisperOpts.language = std::string([(NSString *)w[@"language"] UTF8String]);
                if (w[@"task"] != nil) whisperOpts.task = std::string([(NSString *)w[@"task"] UTF8String]);
                if (w[@"tailPaddings"] != nil) whisperOpts.tail_paddings = [(NSNumber *)w[@"tailPaddings"] intValue];
                if (w[@"enableTokenTimestamps"] != nil) {
                    whisperOpts.enable_token_timestamps = [(NSNumber *)w[@"enableTokenTimestamps"] boolValue];
                }
                if (w[@"enableSegmentTimestamps"] != nil) {
                    whisperOpts.enable_segment_timestamps = [(NSNumber *)w[@"enableSegmentTimestamps"] boolValue];
                }
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
            NSDictionary *q3 = modelOptions[@"qwen3Asr"];
            if ([q3 isKindOfClass:[NSDictionary class]]) {
                if (q3[@"maxTotalLen"] != nil) qwen3AsrOpts.max_total_len = [(NSNumber *)q3[@"maxTotalLen"] intValue];
                if (q3[@"maxNewTokens"] != nil) qwen3AsrOpts.max_new_tokens = [(NSNumber *)q3[@"maxNewTokens"] intValue];
                if (q3[@"temperature"] != nil) qwen3AsrOpts.temperature = [(NSNumber *)q3[@"temperature"] floatValue];
                if (q3[@"topP"] != nil) qwen3AsrOpts.top_p = [(NSNumber *)q3[@"topP"] floatValue];
                if (q3[@"seed"] != nil) qwen3AsrOpts.seed = [(NSNumber *)q3[@"seed"] intValue];
                if (q3[@"hotwords"] != nil) qwen3AsrOpts.hotwords = std::string([(NSString *)q3[@"hotwords"] UTF8String]);
                qwen3AsrOptsPtr = &qwen3AsrOpts;
            }
            NSDictionary *cohere = modelOptions[@"cohereTranscribe"];
            if ([cohere isKindOfClass:[NSDictionary class]]) {
                if (cohere[@"language"] != nil) cohereTranscribeOpts.language = std::string([(NSString *)cohere[@"language"] UTF8String]);
                if (cohere[@"usePunct"] != nil) cohereTranscribeOpts.use_punct = [(NSNumber *)cohere[@"usePunct"] boolValue];
                if (cohere[@"useItn"] != nil) cohereTranscribeOpts.use_itn = [(NSNumber *)cohere[@"useItn"] boolValue];
                cohereTranscribeOptsPtr = &cohereTranscribeOpts;
            }
        }

        sherpaonnx::SttInitializeResult result = inst->wrapper->initialize(
            modelDirStr, preferInt8Opt, modelTypeOpt, debugVal, hotwordsFileOpt, hotwordsScoreOpt,
            numThreadsOpt, providerOpt, ruleFstsOpt, ruleFarsOpt, ditherOpt,
            whisperOptsPtr, senseVoiceOptsPtr, canaryOptsPtr, funasrNanoOptsPtr, qwen3AsrOptsPtr,
            cohereTranscribeOptsPtr);

        if (result.success) {
            RCTLogInfo(@"Sherpa-onnx initialized successfully");

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
            if (!result.modelType.empty()) {
                resultDict[@"modelType"] = [NSString stringWithUTF8String:result.modelType.c_str()];
            }
            if (!result.decodingMethod.empty()) {
                resultDict[@"decodingMethod"] = [NSString stringWithUTF8String:result.decodingMethod.c_str()];
            }

            resolve(resultDict);
        } else {
            NSString *errorMsg = result.error.empty()
                ? [NSString stringWithFormat:@"Failed to initialize sherpa-onnx with model directory: %@", modelDir]
                : [NSString stringWithUTF8String:result.error.c_str()];
            RCTLogError(@"%@", errorMsg);
            reject(kSttErrInitFailed, errorMsg, nil);
        }
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception during initialization: %@", exception.reason];
        RCTLogError(@"%@", errorMsg);
        reject(kSttErrInitFailed, errorMsg, nil);
    }
}

- (void)detectSttModel:(NSString *)modelDir
            assetName:(NSString *)assetName
            modelType:(NSString *)modelType
           preferInt8:(NSNumber *)preferInt8
                debug:(NSNumber *)debug
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
    RCTLogInfo(@"Detecting STT model: modelDir=%@ assetName=%@", modelDir, assetName);
    @try {
        std::optional<std::string> modelDirOpt = std::nullopt;
        if (modelDir != nil && [modelDir length] > 0) {
            modelDirOpt = std::string([modelDir UTF8String]);
        }
        std::optional<std::string> assetNameOpt = std::nullopt;
        if (assetName != nil && [assetName length] > 0) {
            assetNameOpt = std::string([assetName UTF8String]);
        }
        std::optional<bool> preferInt8Opt = std::nullopt;
        if (preferInt8 != nil) {
            preferInt8Opt = [preferInt8 boolValue];
        }
        const std::string modelTypeStr =
            (modelType != nil && [modelType length] > 0) ? [modelType UTF8String] : "auto";
        const bool debugVal = (debug != nil && [debug boolValue]);
        sherpaonnx::SttDetectResult result =
            sherpaonnx::DetectSttModel(modelDirOpt, assetNameOpt, modelTypeStr, preferInt8Opt, debugVal);

        NSMutableDictionary *resultDict = [NSMutableDictionary dictionary];
        resultDict[@"success"] = @(result.ok);
        resultDict[@"isStreaming"] = @(result.isStreaming);
        resultDict[@"isHardwareSpecificUnsupported"] = @(result.isHardwareSpecificUnsupported);
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
        if (!result.derivedLanguages.empty()) {
            NSMutableArray *langs = [NSMutableArray array];
            for (const auto& id : result.derivedLanguages) {
                [langs addObject:[NSString stringWithUTF8String:id.c_str()]];
            }
            resultDict[@"languages"] = langs;
        }
        if (!result.quantization.empty()) {
            resultDict[@"quantization"] = [NSString stringWithUTF8String:result.quantization.c_str()];
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
        NSString *errorMsg = [NSString stringWithFormat:@"STT model detection failed: %@", exception.reason];
        RCTLogError(@"%@", errorMsg);
        reject(@"STT_MODEL_DETECTION_FAILED", errorMsg, nil);
    }
}

- (void)setSttConfig:(NSString *)instanceId
             options:(NSDictionary *)options
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(kSttErrConfigFailed, @"instanceId is required", nil);
        return;
    }
    std::string instanceIdStr = [instanceId UTF8String];
    std::lock_guard<std::mutex> lock(g_stt_mutex);
    auto it = g_stt_instances.find(instanceIdStr);
    if (it == g_stt_instances.end() || it->second->wrapper == nullptr || !it->second->wrapper->isInitialized()) {
        reject(kSttErrInstanceNotFound, @"STT not initialized. Call initializeStt first.", nil);
        return;
    }
    sherpaonnx::SttWrapper *wrapper = it->second->wrapper.get();
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
        try {
            wrapper->setConfig(opts);
            resolve(nil);
        } catch (const std::exception& e) {
            NSString *reason = e.what() ? [NSString stringWithUTF8String:e.what()] : @"Unknown error";
            RCTLogError(@"setSttConfig: %@", reason);
            reject(kSttErrConfigFailed, reason, nil);
        }
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception in setSttConfig: %@", exception.reason ?: @""];
        RCTLogError(@"%@", errorMsg);
        reject(kSttErrConfigFailed, errorMsg, nil);
    }
}

- (void)unloadStt:(NSString *)instanceId
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        resolve(nil);
        return;
    }
    std::string instanceIdStr = [instanceId UTF8String];
    @try {
        std::lock_guard<std::mutex> lock(g_stt_mutex);
        auto it = g_stt_instances.find(instanceIdStr);
        if (it != g_stt_instances.end()) {
            it->second->wrapper->release();
            it->second->wrapper.reset();
            g_stt_instances.erase(it);
        }
        RCTLogInfo(@"STT instance %@ released", instanceId);
        resolve(nil);
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception during cleanup: %@", exception.reason];
        RCTLogError(@"%@", errorMsg);
        reject(kSttErrInternalError, errorMsg, nil);
    }
}

// ==================== Transcribe ====================

- (void)transcribe:(NSString *)instanceId
          bufferId:(NSString *)bufferId
   textOutBufferId:(NSString *)textOutBufferId
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(kSttErrInstanceNotFound, @"instanceId is required", nil);
        return;
    }
    std::string instanceIdStr = [instanceId UTF8String];
    std::string bufferIdStr = [bufferId UTF8String];
    std::string textOutIdStr = [textOutBufferId UTF8String];

    std::lock_guard<std::mutex> lock(g_stt_mutex);
    auto it = g_stt_instances.find(instanceIdStr);
    if (it == g_stt_instances.end() || it->second->wrapper == nullptr || !it->second->wrapper->isInitialized()) {
        reject(kSttErrInstanceNotFound, @"STT not initialized. Call initializeStt first.", nil);
        return;
    }

    // Verify text output buffer exists and is currently empty
    {
        std::string existingText;
        std::string textReadError;
        if (txt_read_offline_text(textOutIdStr, &existingText, &textReadError)) {
            reject(kSttErrAlreadyPopulated, @"Text buffer already populated", nil);
            return;
        }
        if (textReadError.find("not found") != std::string::npos) {
            reject(kSttErrTextBufferNotFound,
                   [NSString stringWithFormat:@"Offline text buffer not found: %@", textOutBufferId], nil);
            return;
        }
    }

    // Read offline audio via shared helper API
    std::vector<float> samples;
    int sampleRate = 0;
    if (!pa_read_offline_samples(bufferIdStr, &samples, &sampleRate)) {
        auto liveEntry = pa_get_live_entry(bufferIdStr);
        if (liveEntry != nullptr) {
            reject(
                kSttErrBufferKindMismatch,
                [NSString stringWithFormat:@"Buffer kind mismatch: expected offline buffer, got live buffer: %@", bufferId],
                nil);
            return;
        }
        reject(kSttErrBufferNotFound,
               [NSString stringWithFormat:@"Offline audio buffer not found: %@", bufferId], nil);
        return;
    }

    if (samples.empty()) {
        reject(kSttErrBufferNotFound, @"Audio buffer is empty", nil);
        return;
    }

    SttInstanceState *inst = it->second.get();
    try {
        sherpaonnx::SttRecognitionResult result = inst->wrapper->transcribeSamples(samples, static_cast<int32_t>(sampleRate));
        std::string populateError;
        if (!txt_populate_offline_if_empty(
              textOutIdStr,
              result.text,
              result.tokens,
              result.timestamps,
              result.durations,
              result.lang,
              result.emotion,
              result.event,
              &populateError)) {
            reject(kSttErrAlreadyPopulated, @"Text buffer already populated", nil);
            return;
        }
        resolve(nil);
    } catch (const std::bad_alloc&) {
        reject(kSttErrOfflineOom, kSttOfflineOomMessage, nil);
    } catch (const std::exception& e) {
        NSString *errorMsg = e.what() ? [NSString stringWithUTF8String:e.what()] : @"Recognition failed.";
        if (!errorMsg) errorMsg = @"Recognition failed.";
        reject(kSttErrTranscribeFailed, errorMsg, nil);
    } catch (...) {
        reject(kSttErrTranscribeFailed, @"Unknown error during buffer transcription", nil);
    }
}

@end
