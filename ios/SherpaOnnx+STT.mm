/**
 * SherpaOnnx+STT.mm
 *
 * Purpose: STT (speech-to-text) TurboModule methods: initializeStt, releaseStt, runStt, and related.
 * Uses sherpa-onnx-stt-wrapper for native recognition and sherpa-onnx-model-detect for model detection.
 */

#import "SherpaOnnx.h"
#import <React/RCTLog.h>

#include "sherpa-onnx-stt-wrapper.h"
#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx/c-api/cxx-api.h"
#include "sherpa_onnx_alignment_engine.hpp"
#include <atomic>
#include <fstream>
#include <iomanip>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

// ==================== Error Code Constants ====================
static NSString *const kSttErrInvalidArgument = @"STT_INVALID_ARGUMENT";
static NSString *const kSttErrInitFailed = @"STT_INIT_FAILED";
static NSString *const kSttErrTranscribeFailed = @"STT_TRANSCRIBE_FAILED";
static NSString *const kSttErrConfigFailed = @"STT_CONFIG_FAILED";
static NSString *const kSttErrInstanceNotFound = @"STT_INSTANCE_NOT_FOUND";
static NSString *const kSttErrResultStale = @"STT_STALE_RESULT";
static NSString *const kSttErrResultEmpty = @"STT_RESULT_EMPTY";
static NSString *const kSttErrBufferNotFound = @"STT_BUFFER_NOT_FOUND";
static NSString *const kSttErrSliceInvalid = @"STT_SLICE_INVALID";
static NSString *const kSttErrSliceTooLarge = @"STT_SLICE_TOO_LARGE";
static NSString *const kSttErrInternalError = @"STT_INTERNAL_ERROR";
static NSString *const kSttErrAlignmentFailed = @"STT_ALIGNMENT_FAILED";
static NSString *const kSttErrAlignmentNotFound = @"STT_ALIGNMENT_NOT_FOUND";
static NSString *const kSttErrAlignmentInputMismatch = @"STT_ALIGNMENT_INPUT_MISMATCH";
static NSString *const kSttErrAlignmentSliceInvalid = @"STT_ALIGNMENT_SLICE_INVALID";
static NSString *const kSttErrAlignmentSliceTooLarge = @"STT_ALIGNMENT_SLICE_TOO_LARGE";

// ==================== Slice Constants ====================
static const int kSttDefaultSliceCount = 1024;
static const int kSttMaxSliceCount = 16384;
static const int kAlignmentDefaultSliceCount = 512;
static const int kAlignmentMaxSliceCount = 8192;

// ==================== Retained Result ====================
struct SttRetainedResult {
    std::string text;
    std::vector<std::string> tokens;
    std::vector<float> timestamps;
    std::vector<float> durations;
    std::string lang;
    std::string emotion;
    std::string event;
    int32_t sampleRate;
    std::string source;
};

// ==================== Result Slot ====================
static std::atomic<int64_t> g_stt_result_id_counter{0};

struct SttResultSlot {
    int64_t resultId = -1;
    std::unique_ptr<SttRetainedResult> retained;

    int64_t store(std::unique_ptr<SttRetainedResult> r) {
        retained = std::move(r);
        resultId = g_stt_result_id_counter.fetch_add(1) + 1;
        return resultId;
    }

    void release() {
        retained.reset();
        resultId = -1;
    }

    bool isStale(int64_t id) const { return id != resultId; }
    bool isEmpty() const { return retained == nullptr; }
};

// ==================== Audio Buffer Registry ====================
struct AudioBuffer {
    std::string bufferId;
    std::string kind;
    std::vector<float> samples;
    int32_t sampleRate;
    int32_t channelCount;
};

static std::unordered_map<std::string, std::unique_ptr<AudioBuffer>> g_audio_buffers;
static std::mutex g_audio_buffer_mutex;

struct SttAlignmentSegment {
    std::string text;
    double startSec;
    double endSec;
};

struct SttAlignmentRecord {
    int64_t alignmentId;
    std::vector<SttAlignmentSegment> segments;
    int32_t tokenCount; // -1 = unknown (e.g. alignTextToBuffer where accurate count isn't available)
};

static std::atomic<int64_t> g_alignment_id_counter{0};
static std::unordered_map<int64_t, SttAlignmentRecord> g_stt_alignments;
static std::mutex g_stt_alignment_mutex;

static NSDictionary *audioBufferToDict(const AudioBuffer& buf) {
    double durationMs = (buf.samples.size() > 0 && buf.sampleRate > 0)
        ? (double)buf.samples.size() / buf.sampleRate * 1000.0
        : 0.0;
    return @{
        @"bufferId": [NSString stringWithUTF8String:buf.bufferId.c_str()],
        @"kind": [NSString stringWithUTF8String:buf.kind.c_str()],
        @"sampleRate": @(buf.sampleRate),
        @"channelCount": @(buf.channelCount),
        @"numSamples": @((int)buf.samples.size()),
        @"durationMs": @(durationMs)
    };
}

// ==================== Instance State ====================
struct SttInstanceState {
    std::unique_ptr<sherpaonnx::SttWrapper> wrapper;
    SttResultSlot resultSlot;
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

static NSDictionary *sttTranscribeRefToDict(int64_t resultId, const SttRetainedResult& r) {
    NSString *text = [NSString stringWithUTF8String:r.text.c_str()] ?: @"";
    return @{
        @"success": @YES,
        @"resultId": @(resultId),
        @"sampleRate": @(r.sampleRate),
        @"textLength": @((NSUInteger)text.length),
        @"tokenCount": @((int)r.tokens.size()),
        @"timestampCount": @((int)r.timestamps.size()),
        @"durationCount": @((int)r.durations.size()),
        @"hasLang": @(!r.lang.empty()),
        @"hasEmotion": @(!r.emotion.empty()),
        @"hasEvent": @(!r.event.empty()),
        @"source": [NSString stringWithUTF8String:r.source.c_str()]
    };
}

static std::unique_ptr<SttRetainedResult> retainResult(const sherpaonnx::SttRecognitionResult& r, int32_t sampleRate, const std::string& source) {
    auto retained = std::make_unique<SttRetainedResult>();
    retained->text = r.text;
    retained->tokens = r.tokens;
    retained->timestamps = r.timestamps;
    retained->durations = r.durations;
    retained->lang = r.lang;
    retained->emotion = r.emotion;
    retained->event = r.event;
    retained->sampleRate = sampleRate;
    retained->source = source;
    return retained;
}

static std::vector<float> resampleLinear(
    const std::vector<float>& input,
    int32_t inputRate,
    int32_t outputRate) {
    if (input.empty() || inputRate <= 0 || outputRate <= 0 || inputRate == outputRate) {
        return input;
    }

    const size_t outputSize = std::max<size_t>(
        1,
        static_cast<size_t>((static_cast<double>(input.size()) * outputRate) / inputRate));

    std::vector<float> out(outputSize);
    const double ratio = static_cast<double>(inputRate) / outputRate;
    for (size_t i = 0; i < outputSize; ++i) {
        const double src = i * ratio;
        const size_t left = static_cast<size_t>(src);
        const size_t right = std::min(left + 1, input.size() - 1);
        const float frac = static_cast<float>(src - left);
        out[i] = input[left] + (input[right] - input[left]) * frac;
    }

    return out;
}

static std::string sttGranularityToAlignmentGranularity(NSString *granularity) {
    NSString *g = granularity != nil
        ? [[granularity lowercaseString] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]
        : @"segment";

    if (g.length == 0 || [g isEqualToString:@"segment"]) return "sentence";
    if ([g isEqualToString:@"word"]) return "word";
    if ([g isEqualToString:@"token"]) return "character";
    throw std::invalid_argument("Unsupported granularity");
}

static std::string formatSubtitleTimestamp(double seconds, bool useDotSeparator) {
    long long totalMs = static_cast<long long>(std::max(0.0, seconds) * 1000.0);
    long long hours = totalMs / 3600000;
    long long minutes = (totalMs % 3600000) / 60000;
    long long secs = (totalMs % 60000) / 1000;
    long long millis = totalMs % 1000;

    std::ostringstream oss;
    oss << std::setfill('0') << std::setw(2) << hours
        << ":" << std::setw(2) << minutes
        << ":" << std::setw(2) << secs
        << (useDotSeparator ? '.' : ',')
        << std::setw(3) << millis;
    return oss.str();
}

static std::string escapeJson(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (char c : s) {
        switch (c) {
            case '\\': out += "\\\\"; break;
            case '"': out += "\\\""; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default: out += c; break;
        }
    }
    return out;
}

static bool saveAlignmentAsJson(const SttAlignmentRecord& record, const std::string& targetPath, std::string *errorOut) {
    std::ofstream out(targetPath, std::ios::out | std::ios::trunc);
    if (!out.is_open()) {
        if (errorOut) *errorOut = "Could not open target file";
        return false;
    }

    out << "[";
    for (size_t i = 0; i < record.segments.size(); ++i) {
        const auto &seg = record.segments[i];
        if (i > 0) out << ",";
        out << "{\"text\":\"" << escapeJson(seg.text)
            << "\",\"startSec\":" << seg.startSec
            << ",\"endSec\":" << seg.endSec
            << "}";
    }
    out << "]";
    return true;
}

static bool saveAlignmentAsSrtVtt(const SttAlignmentRecord& record, const std::string& targetPath, bool vtt, std::string *errorOut) {
    std::ofstream out(targetPath, std::ios::out | std::ios::trunc);
    if (!out.is_open()) {
        if (errorOut) *errorOut = "Could not open target file";
        return false;
    }

    if (vtt) {
        out << "WEBVTT\n\n";
    }

    for (size_t i = 0; i < record.segments.size(); ++i) {
        const auto &seg = record.segments[i];
        if (!vtt) {
            out << (i + 1) << "\n";
        }
        out << formatSubtitleTimestamp(seg.startSec, vtt)
            << " --> "
            << formatSubtitleTimestamp(seg.endSec, vtt)
            << "\n"
            << seg.text
            << "\n\n";
    }

    return true;
}

static bool validateSliceArgs(int start, int maxCount, int totalCount, RCTPromiseRejectBlock reject) {
    if (start < 0) {
        reject(kSttErrSliceInvalid,
               [NSString stringWithFormat:@"start must be >= 0, got %d", start], nil);
        return false;
    }
    if (maxCount <= 0) {
        reject(kSttErrSliceInvalid,
               [NSString stringWithFormat:@"maxCount must be > 0, got %d", maxCount], nil);
        return false;
    }
    if (maxCount > kSttMaxSliceCount) {
        reject(kSttErrSliceTooLarge,
               [NSString stringWithFormat:@"maxCount %d exceeds max %d", maxCount, kSttMaxSliceCount], nil);
        return false;
    }
    (void)totalCount;
    return true;
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

- (void)transcribeFile:(NSString *)instanceId
             filePath:(NSString *)filePath
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(kSttErrInstanceNotFound, @"instanceId is required", nil);
        return;
    }
    std::string instanceIdStr = [instanceId UTF8String];
    std::lock_guard<std::mutex> lock(g_stt_mutex);
    auto it = g_stt_instances.find(instanceIdStr);
    if (it == g_stt_instances.end() || it->second->wrapper == nullptr || !it->second->wrapper->isInitialized()) {
        reject(kSttErrInstanceNotFound, @"STT not initialized. Call initializeStt first.", nil);
        return;
    }
    SttInstanceState *inst = it->second.get();
    try {
        std::string filePathStr = [filePath UTF8String];
        sherpaonnx::SttRecognitionResult result = inst->wrapper->transcribeFile(filePathStr);
        auto retained = retainResult(result, 16000, "file");
        int64_t resultId = inst->resultSlot.store(std::move(retained));
        resolve(sttTranscribeRefToDict(resultId, *inst->resultSlot.retained));
    } catch (const std::exception& e) {
        NSString *errorMsg = e.what() ? [NSString stringWithUTF8String:e.what()] : @"Recognition failed.";
        if (!errorMsg) errorMsg = @"Recognition failed.";
        RCTLogError(@"Transcribe error: %@", errorMsg);
        reject(kSttErrTranscribeFailed, errorMsg, nil);
    } catch (...) {
        reject(kSttErrTranscribeFailed, @"Unknown error during transcription", nil);
    }
}

- (void)transcribeSamples:(NSString *)instanceId
                  samples:(NSArray<NSNumber *> *)samples
                sampleRate:(double)sampleRate
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(kSttErrInstanceNotFound, @"instanceId is required", nil);
        return;
    }
    std::string instanceIdStr = [instanceId UTF8String];
    std::lock_guard<std::mutex> lock(g_stt_mutex);
    auto it = g_stt_instances.find(instanceIdStr);
    if (it == g_stt_instances.end() || it->second->wrapper == nullptr || !it->second->wrapper->isInitialized()) {
        reject(kSttErrInstanceNotFound, @"STT not initialized. Call initializeStt first.", nil);
        return;
    }
    SttInstanceState *inst = it->second.get();
    try {
        std::vector<float> floatSamples;
        floatSamples.reserve([samples count]);
        for (NSNumber *n in samples) {
            floatSamples.push_back([n floatValue]);
        }
        int32_t sr = static_cast<int32_t>(sampleRate);
        sherpaonnx::SttRecognitionResult result = inst->wrapper->transcribeSamples(floatSamples, sr);
        auto retained = retainResult(result, sr, "samples");
        int64_t resultId = inst->resultSlot.store(std::move(retained));
        resolve(sttTranscribeRefToDict(resultId, *inst->resultSlot.retained));
    } catch (const std::exception& e) {
        NSString *errorMsg = e.what() ? [NSString stringWithUTF8String:e.what()] : @"Recognition failed.";
        if (!errorMsg) errorMsg = @"Recognition failed.";
        RCTLogError(@"TranscribeSamples error: %@", errorMsg);
        reject(kSttErrTranscribeFailed, errorMsg, nil);
    } catch (...) {
        reject(kSttErrTranscribeFailed, @"Unknown error during transcription", nil);
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
            it->second->resultSlot.release();
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

// ==================== Audio Buffer Registry Methods ====================

- (void)createAudioBufferFromFile:(NSString *)sourcePath
              targetSampleRateHz:(NSNumber *)targetSampleRateHz
                       forceMono:(NSNumber *)forceMono
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
    @try {
        std::string sourcePathStr = [sourcePath UTF8String];

        // Use sherpa-onnx CXX ReadWave to load audio
        sherpa_onnx::cxx::Wave waveData;
        try {
            waveData = sherpa_onnx::cxx::ReadWave(sourcePathStr);
        } catch (const std::exception& e) {
            reject(kSttErrTranscribeFailed,
                   [NSString stringWithFormat:@"Failed to read audio file: %s", e.what()], nil);
            return;
        }
        if (waveData.samples.empty()) {
            reject(kSttErrTranscribeFailed, @"Audio file is empty", nil);
            return;
        }

        // Generate UUID for bufferId
        NSString *uuid = [[NSUUID UUID] UUIDString];
        std::string bufferId = [uuid UTF8String];

        int32_t inputRate = static_cast<int32_t>(waveData.sample_rate);
        int32_t outputRate = inputRate;
        if (targetSampleRateHz != nil) {
            outputRate = (int32_t)[targetSampleRateHz intValue];
            if (outputRate <= 0) {
                reject(kSttErrInvalidArgument, @"targetSampleRateHz must be > 0", nil);
                return;
            }
        }

        std::vector<float> outputSamples =
            (outputRate == inputRate)
                ? std::move(waveData.samples)
                : resampleLinear(waveData.samples, inputRate, outputRate);

        auto buf = std::make_unique<AudioBuffer>();
        buf->bufferId = bufferId;
        buf->kind = "offlinePcmBuffer";
        buf->samples = std::move(outputSamples);
        buf->sampleRate = outputRate;
        (void)forceMono; // ReadWave already returns mono PCM.
        buf->channelCount = 1;

        NSDictionary *dict = audioBufferToDict(*buf);
        {
            std::lock_guard<std::mutex> lock(g_audio_buffer_mutex);
            g_audio_buffers[bufferId] = std::move(buf);
        }
        resolve(dict);
    } @catch (NSException *exception) {
        reject(kSttErrTranscribeFailed,
               [NSString stringWithFormat:@"Failed to create audio buffer: %@", exception.reason], nil);
    }
}

- (void)getAudioBufferInfo:(NSString *)bufferId
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
    std::string bufferIdStr = [bufferId UTF8String];
    std::lock_guard<std::mutex> lock(g_audio_buffer_mutex);
    auto it = g_audio_buffers.find(bufferIdStr);
    if (it == g_audio_buffers.end()) {
        reject(kSttErrBufferNotFound,
               [NSString stringWithFormat:@"Audio buffer not found: %@", bufferId], nil);
        return;
    }
    resolve(audioBufferToDict(*it->second));
}

- (void)releaseAudioBuffer:(NSString *)bufferId
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
    std::string bufferIdStr = [bufferId UTF8String];
    std::lock_guard<std::mutex> lock(g_audio_buffer_mutex);
    g_audio_buffers.erase(bufferIdStr);
    resolve(nil);
}

// ==================== Transcribe From Buffer ====================

- (void)transcribeFromAudioBuffer:(NSString *)instanceId
                         bufferId:(NSString *)bufferId
                        sourceTag:(NSString *)sourceTag
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(kSttErrInstanceNotFound, @"instanceId is required", nil);
        return;
    }
    std::string instanceIdStr = [instanceId UTF8String];
    std::string bufferIdStr = [bufferId UTF8String];

    std::lock_guard<std::mutex> lock(g_stt_mutex);
    auto it = g_stt_instances.find(instanceIdStr);
    if (it == g_stt_instances.end() || it->second->wrapper == nullptr || !it->second->wrapper->isInitialized()) {
        reject(kSttErrInstanceNotFound, @"STT not initialized. Call initializeStt first.", nil);
        return;
    }

    std::vector<float> samples;
    int32_t sampleRate = 0;
    {
        std::lock_guard<std::mutex> bufLock(g_audio_buffer_mutex);
        auto bufIt = g_audio_buffers.find(bufferIdStr);
        if (bufIt == g_audio_buffers.end()) {
            reject(kSttErrBufferNotFound,
                   [NSString stringWithFormat:@"Audio buffer not found: %@", bufferId], nil);
            return;
        }
        samples = bufIt->second->samples;
        sampleRate = bufIt->second->sampleRate;
    }

    SttInstanceState *inst = it->second.get();
    try {
        sherpaonnx::SttRecognitionResult result = inst->wrapper->transcribeSamples(samples, sampleRate);
        std::string source = (sourceTag != nil && [sourceTag length] > 0) ? [sourceTag UTF8String] : "buffer";
        auto retained = retainResult(result, sampleRate, source);
        int64_t resultId = inst->resultSlot.store(std::move(retained));
        resolve(sttTranscribeRefToDict(resultId, *inst->resultSlot.retained));
    } catch (const std::exception& e) {
        NSString *errorMsg = e.what() ? [NSString stringWithUTF8String:e.what()] : @"Recognition failed.";
        if (!errorMsg) errorMsg = @"Recognition failed.";
        reject(kSttErrTranscribeFailed, errorMsg, nil);
    } catch (...) {
        reject(kSttErrTranscribeFailed, @"Unknown error during buffer transcription", nil);
    }
}

// ==================== STT Result Getters ====================

- (void)getSttResultText:(NSString *)instanceId
                resultId:(double)resultId
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
    std::string instanceIdStr = [instanceId UTF8String];
    std::lock_guard<std::mutex> lock(g_stt_mutex);
    auto it = g_stt_instances.find(instanceIdStr);
    if (it == g_stt_instances.end()) {
        reject(kSttErrInstanceNotFound, @"STT instance not found", nil);
        return;
    }
    SttResultSlot& slot = it->second->resultSlot;
    if (slot.isEmpty()) {
        reject(kSttErrResultEmpty, @"No result available", nil);
        return;
    }
    if (slot.isStale((int64_t)resultId)) {
        reject(kSttErrResultStale, @"Result is stale (superseded by new transcription)", nil);
        return;
    }
    resolve([NSString stringWithUTF8String:slot.retained->text.c_str()]);
}

- (void)getSttResultTokens:(NSString *)instanceId
                  resultId:(double)resultId
                     start:(double)start
                  maxCount:(double)maxCount
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
    std::string instanceIdStr = [instanceId UTF8String];
    std::lock_guard<std::mutex> lock(g_stt_mutex);
    auto it = g_stt_instances.find(instanceIdStr);
    if (it == g_stt_instances.end()) {
        reject(kSttErrInstanceNotFound, @"STT instance not found", nil);
        return;
    }
    SttResultSlot& slot = it->second->resultSlot;
    if (slot.isEmpty()) { reject(kSttErrResultEmpty, @"No result available", nil); return; }
    if (slot.isStale((int64_t)resultId)) { reject(kSttErrResultStale, @"Result is stale", nil); return; }

    int s = (int)start;
    int mc = (int)maxCount;
    int total = (int)slot.retained->tokens.size();
    if (!validateSliceArgs(s, mc, total, reject)) return;
    if (s >= total) {
        resolve([NSArray array]);
        return;
    }

    int end = std::min(s + mc, total);
    NSMutableArray *arr = [NSMutableArray arrayWithCapacity:(end - s)];
    for (int i = s; i < end; i++) {
        [arr addObject:[NSString stringWithUTF8String:slot.retained->tokens[i].c_str()]];
    }
    resolve(arr);
}

- (void)getSttResultTimestamps:(NSString *)instanceId
                      resultId:(double)resultId
                         start:(double)start
                      maxCount:(double)maxCount
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
    std::string instanceIdStr = [instanceId UTF8String];
    std::lock_guard<std::mutex> lock(g_stt_mutex);
    auto it = g_stt_instances.find(instanceIdStr);
    if (it == g_stt_instances.end()) { reject(kSttErrInstanceNotFound, @"STT instance not found", nil); return; }
    SttResultSlot& slot = it->second->resultSlot;
    if (slot.isEmpty()) { reject(kSttErrResultEmpty, @"No result available", nil); return; }
    if (slot.isStale((int64_t)resultId)) { reject(kSttErrResultStale, @"Result is stale", nil); return; }

    int s = (int)start;
    int mc = (int)maxCount;
    int total = (int)slot.retained->timestamps.size();
    if (!validateSliceArgs(s, mc, total, reject)) return;
    if (s >= total) {
        resolve([NSArray array]);
        return;
    }

    int end = std::min(s + mc, total);
    NSMutableArray *arr = [NSMutableArray arrayWithCapacity:(end - s)];
    for (int i = s; i < end; i++) {
        [arr addObject:@(slot.retained->timestamps[i])];
    }
    resolve(arr);
}

- (void)getSttResultDurations:(NSString *)instanceId
                     resultId:(double)resultId
                        start:(double)start
                     maxCount:(double)maxCount
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
    std::string instanceIdStr = [instanceId UTF8String];
    std::lock_guard<std::mutex> lock(g_stt_mutex);
    auto it = g_stt_instances.find(instanceIdStr);
    if (it == g_stt_instances.end()) { reject(kSttErrInstanceNotFound, @"STT instance not found", nil); return; }
    SttResultSlot& slot = it->second->resultSlot;
    if (slot.isEmpty()) { reject(kSttErrResultEmpty, @"No result available", nil); return; }
    if (slot.isStale((int64_t)resultId)) { reject(kSttErrResultStale, @"Result is stale", nil); return; }

    int s = (int)start;
    int mc = (int)maxCount;
    int total = (int)slot.retained->durations.size();
    if (!validateSliceArgs(s, mc, total, reject)) return;
    if (s >= total) {
        resolve([NSArray array]);
        return;
    }

    int end = std::min(s + mc, total);
    NSMutableArray *arr = [NSMutableArray arrayWithCapacity:(end - s)];
    for (int i = s; i < end; i++) {
        [arr addObject:@(slot.retained->durations[i])];
    }
    resolve(arr);
}

- (void)getSttResultLang:(NSString *)instanceId
                resultId:(double)resultId
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
    std::string instanceIdStr = [instanceId UTF8String];
    std::lock_guard<std::mutex> lock(g_stt_mutex);
    auto it = g_stt_instances.find(instanceIdStr);
    if (it == g_stt_instances.end()) { reject(kSttErrInstanceNotFound, @"STT instance not found", nil); return; }
    SttResultSlot& slot = it->second->resultSlot;
    if (slot.isEmpty()) { reject(kSttErrResultEmpty, @"No result available", nil); return; }
    if (slot.isStale((int64_t)resultId)) { reject(kSttErrResultStale, @"Result is stale", nil); return; }
    resolve([NSString stringWithUTF8String:slot.retained->lang.c_str()]);
}

- (void)getSttResultEmotion:(NSString *)instanceId
                   resultId:(double)resultId
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
    std::string instanceIdStr = [instanceId UTF8String];
    std::lock_guard<std::mutex> lock(g_stt_mutex);
    auto it = g_stt_instances.find(instanceIdStr);
    if (it == g_stt_instances.end()) { reject(kSttErrInstanceNotFound, @"STT instance not found", nil); return; }
    SttResultSlot& slot = it->second->resultSlot;
    if (slot.isEmpty()) { reject(kSttErrResultEmpty, @"No result available", nil); return; }
    if (slot.isStale((int64_t)resultId)) { reject(kSttErrResultStale, @"Result is stale", nil); return; }
    resolve([NSString stringWithUTF8String:slot.retained->emotion.c_str()]);
}

- (void)getSttResultEvent:(NSString *)instanceId
                 resultId:(double)resultId
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
    std::string instanceIdStr = [instanceId UTF8String];
    std::lock_guard<std::mutex> lock(g_stt_mutex);
    auto it = g_stt_instances.find(instanceIdStr);
    if (it == g_stt_instances.end()) { reject(kSttErrInstanceNotFound, @"STT instance not found", nil); return; }
    SttResultSlot& slot = it->second->resultSlot;
    if (slot.isEmpty()) { reject(kSttErrResultEmpty, @"No result available", nil); return; }
    if (slot.isStale((int64_t)resultId)) { reject(kSttErrResultStale, @"Result is stale", nil); return; }
    resolve([NSString stringWithUTF8String:slot.retained->event.c_str()]);
}

- (void)releaseSttResult:(NSString *)instanceId
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
    std::string instanceIdStr = [instanceId UTF8String];
    std::lock_guard<std::mutex> lock(g_stt_mutex);
    auto it = g_stt_instances.find(instanceIdStr);
    if (it != g_stt_instances.end()) {
        it->second->resultSlot.release();
    }
    resolve(nil);
}

// ==================== Alignment Stage ====================

- (void)alignSttResult:(NSString *)instanceId
              resultId:(double)resultId
              bufferId:(NSString *)bufferId
      alignmentModelId:(NSString *)alignmentModelId
           granularity:(NSString *)granularity
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(kSttErrInstanceNotFound, @"instanceId is required", nil);
        return;
    }

    std::string instanceIdStr = [instanceId UTF8String];
    std::vector<float> samples;
    int32_t bufferSampleRate = 0;
    std::string text;
    int32_t tokenCount = 0;

    {
        std::lock_guard<std::mutex> sttLock(g_stt_mutex);
        auto it = g_stt_instances.find(instanceIdStr);
        if (it == g_stt_instances.end()) {
            reject(kSttErrInstanceNotFound, @"STT instance not found", nil);
            return;
        }

        SttResultSlot& slot = it->second->resultSlot;
        if (slot.isEmpty()) {
            reject(kSttErrResultEmpty, @"No result available", nil);
            return;
        }
        if (slot.isStale((int64_t)resultId)) {
            reject(kSttErrResultStale, @"Result is stale", nil);
            return;
        }

        text = slot.retained->text;
        tokenCount = (int32_t)slot.retained->tokens.size();

        std::string bufferIdStr = [bufferId UTF8String];
        std::lock_guard<std::mutex> bufferLock(g_audio_buffer_mutex);
        auto bit = g_audio_buffers.find(bufferIdStr);
        if (bit == g_audio_buffers.end()) {
            reject(kSttErrBufferNotFound, @"Audio buffer not found", nil);
            return;
        }

        if (slot.retained->sampleRate != bit->second->sampleRate) {
            reject(
                kSttErrAlignmentInputMismatch,
                [NSString stringWithFormat:@"STT result sampleRate (%d) does not match buffer sampleRate (%d)",
                                           slot.retained->sampleRate,
                                           bit->second->sampleRate],
                nil);
            return;
        }

        samples = bit->second->samples;
        bufferSampleRate = bit->second->sampleRate;
    }

    try {
        const std::string alignGranularity = sttGranularityToAlignmentGranularity(granularity);
        const bool useAccurate = (alignmentModelId != nil && [alignmentModelId length] > 0);

        sherpa_onnx::alignment::AlignmentResult aligned;
        if (useAccurate) {
            std::string modelPath = [[alignmentModelId stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] UTF8String];
            if (modelPath.empty()) {
                reject(kSttErrInvalidArgument, @"alignmentModelId must not be empty for accurate mode", nil);
                return;
            }
            aligned = sherpa_onnx::alignment::AlignAccurateFromPcm(
                modelPath,
                text,
                samples.data(),
                samples.size(),
                bufferSampleRate,
                alignGranularity);
        } else {
            aligned = sherpa_onnx::alignment::AlignProportional(
                text,
                (int32_t)samples.size(),
                bufferSampleRate,
                alignGranularity);
        }

        std::vector<SttAlignmentSegment> segments;
        segments.reserve(aligned.subtitles.size());
        for (const auto& item : aligned.subtitles) {
            segments.push_back(SttAlignmentSegment{
                item.text,
                item.start_s,
                item.end_s,
            });
        }

        const int64_t alignmentId = g_alignment_id_counter.fetch_add(1) + 1;
        {
            std::lock_guard<std::mutex> lock(g_stt_alignment_mutex);
            g_stt_alignments[alignmentId] = SttAlignmentRecord{
                alignmentId,
                std::move(segments),
                tokenCount,
            };
        }

        resolve(@{
            @"success": @YES,
            @"alignmentId": @(alignmentId),
            @"segmentCount": @((int)aligned.subtitles.size()),
            @"tokenCount": @(tokenCount),
        });
    } catch (const std::invalid_argument& e) {
        NSString *msg = [NSString stringWithUTF8String:e.what()] ?: @"Invalid alignment arguments";
        reject(kSttErrInvalidArgument, msg, nil);
    } catch (const std::exception& e) {
        NSString *msg = [NSString stringWithUTF8String:e.what()] ?: @"Alignment failed";
        reject(kSttErrAlignmentFailed, msg, nil);
    } catch (...) {
        reject(kSttErrAlignmentFailed, @"Alignment failed", nil);
    }
}

- (void)alignTextToBuffer:(NSString *)text
                 bufferId:(NSString *)bufferId
         alignmentModelId:(NSString *)alignmentModelId
              granularity:(NSString *)granularity
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
    if (text == nil || [text length] == 0) {
        reject(kSttErrInvalidArgument, @"text is required", nil);
        return;
    }

    std::vector<float> samples;
    int32_t bufferSampleRate = 0;
    {
        std::string bufferIdStr = [bufferId UTF8String];
        std::lock_guard<std::mutex> bufferLock(g_audio_buffer_mutex);
        auto bit = g_audio_buffers.find(bufferIdStr);
        if (bit == g_audio_buffers.end()) {
            reject(kSttErrBufferNotFound, @"Audio buffer not found", nil);
            return;
        }
        samples = bit->second->samples;
        bufferSampleRate = bit->second->sampleRate;
    }

    try {
        const std::string alignGranularity = sttGranularityToAlignmentGranularity(granularity);
        const std::string textStr = [text UTF8String];
        const bool useAccurate = (alignmentModelId != nil && [alignmentModelId length] > 0);

        sherpa_onnx::alignment::AlignmentResult aligned;
        if (useAccurate) {
            std::string modelPath = [[alignmentModelId stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] UTF8String];
            if (modelPath.empty()) {
                reject(kSttErrInvalidArgument, @"alignmentModelId must not be empty for accurate mode", nil);
                return;
            }
            aligned = sherpa_onnx::alignment::AlignAccurateFromPcm(
                modelPath,
                textStr,
                samples.data(),
                samples.size(),
                bufferSampleRate,
                alignGranularity);
        } else {
            aligned = sherpa_onnx::alignment::AlignProportional(
                textStr,
                (int32_t)samples.size(),
                bufferSampleRate,
                alignGranularity);
        }

        std::vector<SttAlignmentSegment> segments;
        segments.reserve(aligned.subtitles.size());
        for (const auto& item : aligned.subtitles) {
            segments.push_back(SttAlignmentSegment{
                item.text,
                item.start_s,
                item.end_s,
            });
        }

        const int64_t alignmentId = g_alignment_id_counter.fetch_add(1) + 1;
        {
            std::lock_guard<std::mutex> lock(g_stt_alignment_mutex);
            g_stt_alignments[alignmentId] = SttAlignmentRecord{
                alignmentId,
                std::move(segments),
                -1,
            };
        }

        resolve(@{
            @"success": @YES,
            @"alignmentId": @(alignmentId),
            @"segmentCount": @((int)aligned.subtitles.size()),
        });
    } catch (const std::invalid_argument& e) {
        NSString *msg = [NSString stringWithUTF8String:e.what()] ?: @"Invalid alignment arguments";
        reject(kSttErrInvalidArgument, msg, nil);
    } catch (const std::exception& e) {
        NSString *msg = [NSString stringWithUTF8String:e.what()] ?: @"Alignment failed";
        reject(kSttErrAlignmentFailed, msg, nil);
    } catch (...) {
        reject(kSttErrAlignmentFailed, @"Alignment failed", nil);
    }
}

- (void)getAlignmentSegments:(double)alignmentId
                       start:(double)start
                    maxCount:(double)maxCount
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject
{
    const int64_t id = (int64_t)alignmentId;
    SttAlignmentRecord record;
    {
        std::lock_guard<std::mutex> lock(g_stt_alignment_mutex);
        auto it = g_stt_alignments.find(id);
        if (it == g_stt_alignments.end()) {
            reject(kSttErrAlignmentNotFound, @"Alignment not found", nil);
            return;
        }
        record = it->second;
    }

    const int s = (int)start;
    const int mc = (int)maxCount;
    if (s < 0) {
        reject(kSttErrAlignmentSliceInvalid, [NSString stringWithFormat:@"start must be >= 0, got %d", s], nil);
        return;
    }
    if (mc <= 0) {
        reject(kSttErrAlignmentSliceInvalid, [NSString stringWithFormat:@"maxCount must be > 0, got %d", mc], nil);
        return;
    }
    if (mc > kAlignmentMaxSliceCount) {
        reject(kSttErrAlignmentSliceTooLarge, [NSString stringWithFormat:@"maxCount %d exceeds max %d", mc, kAlignmentMaxSliceCount], nil);
        return;
    }

    if (s >= (int)record.segments.size()) {
        resolve(@[]);
        return;
    }

    const int end = std::min(s + mc, (int)record.segments.size());
    NSMutableArray *arr = [NSMutableArray arrayWithCapacity:(end - s)];
    for (int i = s; i < end; ++i) {
        const auto &seg = record.segments[i];
        [arr addObject:@{
            @"text": [NSString stringWithUTF8String:seg.text.c_str()] ?: @"",
            @"startSec": @(seg.startSec),
            @"endSec": @(seg.endSec),
        }];
    }
    resolve(arr);
}

- (void)saveAlignment:(double)alignmentId
           targetPath:(NSString *)targetPath
               format:(NSString *)format
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
    const int64_t id = (int64_t)alignmentId;
    SttAlignmentRecord record;
    {
        std::lock_guard<std::mutex> lock(g_stt_alignment_mutex);
        auto it = g_stt_alignments.find(id);
        if (it == g_stt_alignments.end()) {
            reject(kSttErrAlignmentNotFound, @"Alignment not found", nil);
            return;
        }
        record = it->second;
    }

    @try {
        NSString *fmt = [format isKindOfClass:[NSString class]] ? [format lowercaseString] : @"json";
        if (fmt == nil || [fmt length] == 0) {
            fmt = @"json";
        }

        NSString *dir = [targetPath stringByDeletingLastPathComponent];
        if (dir != nil && [dir length] > 0) {
            [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
        }

        std::string err;
        const std::string outPath = [targetPath UTF8String];
        bool ok = false;
        if ([fmt isEqualToString:@"json"]) {
            ok = saveAlignmentAsJson(record, outPath, &err);
        } else if ([fmt isEqualToString:@"srt"]) {
            ok = saveAlignmentAsSrtVtt(record, outPath, false, &err);
        } else if ([fmt isEqualToString:@"vtt"]) {
            ok = saveAlignmentAsSrtVtt(record, outPath, true, &err);
        } else {
            reject(kSttErrInvalidArgument, [NSString stringWithFormat:@"Unsupported alignment format: %@", fmt], nil);
            return;
        }

        if (!ok) {
            NSString *msg = [NSString stringWithUTF8String:err.c_str()] ?: @"Failed to save alignment";
            reject(kSttErrAlignmentFailed, msg, nil);
            return;
        }

        resolve(nil);
    } @catch (NSException *exception) {
        reject(kSttErrAlignmentFailed, [NSString stringWithFormat:@"Failed to save alignment: %@", exception.reason], nil);
    }
}

- (void)releaseAlignment:(double)alignmentId
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
    std::lock_guard<std::mutex> lock(g_stt_alignment_mutex);
    g_stt_alignments.erase((int64_t)alignmentId);
    resolve(nil);
}

@end
