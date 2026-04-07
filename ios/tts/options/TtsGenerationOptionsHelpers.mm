#import "TtsGenerationOptionsHelpers.h"

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

std::optional<sherpaonnx::VoiceCloneOptions> VoiceCloneOptionsFromNSDictionary(NSDictionary *options, int32_t defaultNumSteps) {
    if (options == nil) return std::nullopt;
    NSArray *refArr = options[@"referenceAudio"];
    if (![refArr isKindOfClass:[NSArray class]] || [refArr count] == 0) return std::nullopt;
    NSNumber *srNum = options[@"referenceSampleRate"];
    if (srNum == nil || [srNum doubleValue] <= 0) return std::nullopt;

    sherpaonnx::VoiceCloneOptions vo;
    vo.reference_sample_rate = static_cast<int32_t>([srNum doubleValue]);
    vo.reference_audio.reserve([refArr count]);
    for (id elem in refArr) {
        float v = 0.f;
        if ([elem isKindOfClass:[NSNumber class]]) {
            v = static_cast<float>([(NSNumber *)elem doubleValue]);
        }
        vo.reference_audio.push_back(v);
    }
    NSString *rt = options[@"referenceText"];
    if (rt != nil && [rt length] > 0) {
        vo.reference_text = std::string([rt UTF8String]);
    }
    if (options[@"numSteps"] != nil) {
        vo.num_steps = static_cast<int32_t>([options[@"numSteps"] doubleValue]);
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

BOOL NSDictionaryHasValidReferenceAudio(NSDictionary *options) {
    auto o = VoiceCloneOptionsFromNSDictionary(options, 1);
    return o.has_value() && !o->reference_audio.empty() && o->reference_sample_rate > 0;
}

NSString *SubtitleModeFromOptions(NSDictionary *options) {
    NSString *raw = [options[@"subtitleMode"] isKindOfClass:[NSString class]] ? options[@"subtitleMode"] : nil;
    NSString *normalized = raw != nil
        ? [[raw lowercaseString] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]
        : @"fast";

    if ([normalized isEqualToString:@"off"] ||
        [normalized isEqualToString:@"fast"] ||
        [normalized isEqualToString:@"accurate"]) {
        return normalized;
    }

    return @"fast";
}

NSString *SubtitleGranularityFromOptions(NSDictionary *options) {
    NSString *raw = [options[@"subtitleGranularity"] isKindOfClass:[NSString class]] ? options[@"subtitleGranularity"] : nil;
    NSString *normalized = raw != nil
        ? [[raw lowercaseString] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]
        : @"sentence";

    if ([normalized isEqualToString:@"word"] || [normalized isEqualToString:@"sentence"]) {
        return normalized;
    }

    return @"sentence";
}

BOOL IsCharacterGranularityRequested(NSDictionary *options) {
    NSString *raw = [options[@"subtitleGranularity"] isKindOfClass:[NSString class]] ? options[@"subtitleGranularity"] : nil;
    NSString *normalized = raw != nil
        ? [[raw lowercaseString] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]
        : @"";
    return [normalized isEqualToString:@"character"];
}
