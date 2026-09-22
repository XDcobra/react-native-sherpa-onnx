#import "TtsGenerationOptionsHelpers.h"

#include <string>
#include <unordered_map>

const int32_t kDefaultVoiceCloneNumSteps = 5;

NSString *TtsModelKindToNSString(sherpaonnx::TtsModelKind kind) {
    using K = sherpaonnx::TtsModelKind;
    switch (kind) {
        case K::kVits: return @"vits";
        case K::kMatcha: return @"matcha";
        case K::kKokoro: return @"kokoro";
        case K::kKitten: return @"kitten";
        case K::kPocket: return @"pocket";
        case K::kZipvoice: return @"zipvoice";
        case K::kSupertonic: return @"supertonic";
        default: return @"unknown";
    }
}

BOOL NSDictionaryHasVoiceCloneBuffer(NSDictionary *options) {
    if (options == nil) return NO;
    NSString *refId = options[@"referenceAudioBufferId"];
    return refId != nil && [refId isKindOfClass:[NSString class]] && [refId length] > 0;
}

BOOL NSDictionaryHasNumSteps(NSDictionary *options) {
    return options != nil && options[@"numSteps"] != nil;
}

int32_t NumStepsFromNSDictionary(NSDictionary *options, int32_t defaultNumSteps) {
    if (NSDictionaryHasNumSteps(options)) {
        return static_cast<int32_t>([options[@"numSteps"] doubleValue]);
    }
    return defaultNumSteps;
}

BOOL TtsModelKindSupportsNumSteps(sherpaonnx::TtsModelKind kind) {
    using K = sherpaonnx::TtsModelKind;
    return kind == K::kSupertonic || kind == K::kZipvoice || kind == K::kPocket;
}

BOOL TtsModelKindRequiresVoiceCloneForNumSteps(sherpaonnx::TtsModelKind kind) {
    using K = sherpaonnx::TtsModelKind;
    return kind == K::kZipvoice || kind == K::kPocket;
}

std::optional<sherpaonnx::VoiceCloneOptions> GenerationExtraFromOptions(NSDictionary *options) {
    if (options == nil) return std::nullopt;
    std::unordered_map<std::string, std::string> extra;
    id extraDict = options[@"extra"];
    if ([extraDict isKindOfClass:[NSDictionary class]]) {
        NSDictionary *ex = (NSDictionary *)extraDict;
        for (NSString *k in ex) {
            id v = ex[k];
            if ([v isKindOfClass:[NSString class]]) {
                extra[std::string([k UTF8String])] = std::string([(NSString *)v UTF8String]);
            }
        }
    }
    NSString *lang = options[@"lang"];
    if ([lang isKindOfClass:[NSString class]] && [lang length] > 0) {
        extra["lang"] = std::string([lang UTF8String]);
    }
    const BOOL hasNumSteps = NSDictionaryHasNumSteps(options);
    if (extra.empty() && !hasNumSteps) return std::nullopt;

    sherpaonnx::VoiceCloneOptions vo;
    vo.extra = std::move(extra);
    if (hasNumSteps) {
        vo.apply_num_steps = true;
        vo.num_steps = NumStepsFromNSDictionary(options, kDefaultVoiceCloneNumSteps);
    }
    return vo;
}

std::optional<sherpaonnx::VoiceCloneOptions> VoiceCloneOptionsFromBuffer(
    NSDictionary *options,
    const std::vector<float> &refSamples,
    int32_t refSampleRate,
    int32_t defaultNumSteps
) {
    if (refSamples.empty() || refSampleRate <= 0) return std::nullopt;

    sherpaonnx::VoiceCloneOptions vo;
    vo.reference_audio = refSamples;
    vo.reference_sample_rate = refSampleRate;

    NSString *rt = options[@"referenceText"];
    if (rt != nil && [rt length] > 0) {
        vo.reference_text = std::string([rt UTF8String]);
    }
    if (options[@"numSteps"] != nil) {
        vo.num_steps = static_cast<int32_t>([options[@"numSteps"] doubleValue]);
        vo.apply_num_steps = true;
    } else {
        vo.num_steps = defaultNumSteps;
    }
    if (options[@"silenceScale"] != nil) {
        vo.silence_scale = static_cast<float>([options[@"silenceScale"] doubleValue]);
    }
    id extra = options[@"extra"];
    if ([extra isKindOfClass:[NSDictionary class]]) {
        NSDictionary *ex = (NSDictionary *)extra;
        for (NSString *k in ex) {
            id v = ex[k];
            if ([v isKindOfClass:[NSString class]]) {
                vo.extra[std::string([k UTF8String])] = std::string([(NSString *)v UTF8String]);
            }
        }
    }
    return vo;
}
