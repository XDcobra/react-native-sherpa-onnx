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
#include <optional>
#include <sstream>
#include <string>
#include <cmath>
#include <set>
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
        case K::kPocket: return @"pocket";
        case K::kZipvoice: return @"zipvoice";
        case K::kSupertonic: return @"supertonic";
        default: return @"unknown";
    }
}

namespace {
struct SubtitleTimingItem {
    std::string text;
    double start = 0.0;
    double end = 0.0;
};

static bool IsSentenceTerminator(unichar c) {
    switch (c) {
        case '.':
        case '!':
        case '?':
        case ';':
        case 0x3002: // 。
        case 0xFF01: // ！
        case 0xFF1F: // ？
        case 0xFF1B: // ；
            return true;
        default:
            return false;
    }
}

static bool IsTrailingCloser(unichar c) {
    switch (c) {
        case '"':
        case '\'':
        case ')':
        case ']':
        case '}':
        case '>':
        case 0x201D: // ”
        case 0x2019: // ’
        case 0x300D: // 」
        case 0x300F: // 』
        case 0x3011: // 】
        case 0xFF09: // ）
            return true;
        default:
            return false;
    }
}

static bool IsWordDelimiter(unichar c) {
    switch (c) {
        case '.':
        case ',':
        case '!':
        case '?':
        case ';':
        case ':':
        case '(':
        case ')':
        case '[':
        case ']':
        case '{':
        case '}':
        case '"':
        case '\'':
        case '`':
        case '~':
        case '<':
        case '>':
        case '/':
        case '\\':
        case '|':
        case '@':
        case '#':
        case '$':
        case '%':
        case '^':
        case '&':
        case '*':
        case '+':
        case '=':
        case 0x2026: // …
        case 0xFF0C: // ，
        case 0x3002: // 。
        case 0xFF01: // ！
        case 0xFF1F: // ？
        case 0xFF1B: // ；
        case 0xFF1A: // ：
        case 0x3001: // 、
            return true;
        default:
            return false;
    }
}

static bool IsCjkCodepoint(unichar c) {
    return (c >= 0x4E00 && c <= 0x9FFF) ||
           (c >= 0x3400 && c <= 0x4DBF) ||
           (c >= 0x3040 && c <= 0x309F) ||
           (c >= 0x30A0 && c <= 0x30FF) ||
           (c >= 0xAC00 && c <= 0xD7AF);
}

static NSString *ExtractTokenBeforePeriod(NSString *text, NSInteger periodIndex) {
    if (text == nil || text.length == 0 || periodIndex <= 0) {
        return @"";
    }

    NSCharacterSet *ws = [NSCharacterSet whitespaceAndNewlineCharacterSet];
    NSCharacterSet *letters = [NSCharacterSet letterCharacterSet];

    NSInteger i = periodIndex - 1;
    while (i >= 0 && [ws characterIsMember:[text characterAtIndex:i]]) {
        i -= 1;
    }

    NSInteger end = i;
    while (i >= 0) {
        unichar c = [text characterAtIndex:i];
        if ([letters characterIsMember:c] || c == '.') {
            i -= 1;
            continue;
        }
        break;
    }

    if (end < i + 1) {
        return @"";
    }

    NSString *token = [text substringWithRange:NSMakeRange(i + 1, end - i)];
    while (token.length > 0 && [token characterAtIndex:token.length - 1] == '.') {
        token = [token substringToIndex:token.length - 1];
    }
    return token;
}

static bool ShouldSplitOnPeriod(NSString *text, NSInteger periodIndex) {
    if (text == nil || periodIndex < 0 || periodIndex >= text.length) {
        return true;
    }

    NSCharacterSet *digits = [NSCharacterSet decimalDigitCharacterSet];
    if (periodIndex > 0 && periodIndex + 1 < text.length) {
        unichar prev = [text characterAtIndex:periodIndex - 1];
        unichar next = [text characterAtIndex:periodIndex + 1];
        if ([digits characterIsMember:prev] && [digits characterIsMember:next]) {
            return false;
        }
    }

    static const std::set<std::string> kAbbreviations = {
        "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e"
    };

    NSString *token = [[ExtractTokenBeforePeriod(text, periodIndex) lowercaseString]
        stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    std::string tokenUtf8 = token != nil ? std::string([token UTF8String]) : std::string();
    if (!tokenUtf8.empty() && kAbbreviations.find(tokenUtf8) != kAbbreviations.end()) {
        return false;
    }

    if (token.length == 1) {
        NSCharacterSet *upper = [NSCharacterSet uppercaseLetterCharacterSet];
        if ([upper characterIsMember:[token characterAtIndex:0]]) {
            return false;
        }
    }

    return true;
}

static NSInteger SentenceBoundaryEnd(NSString *text, NSInteger index) {
    NSInteger end = index + 1;
    while (end < text.length && IsSentenceTerminator([text characterAtIndex:end])) {
        end += 1;
    }
    while (end < text.length && IsTrailingCloser([text characterAtIndex:end])) {
        end += 1;
    }
    return end;
}

static std::vector<std::string> SanitizeSegments(const std::vector<std::string> &segments) {
    std::vector<std::string> cleaned;
    cleaned.reserve(segments.size());
    for (const auto &segment : segments) {
        NSString *s = [NSString stringWithUTF8String:segment.c_str()];
        if (s == nil) {
            continue;
        }
        NSString *trimmed = [s stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
        if (trimmed.length == 0) {
            continue;
        }
        cleaned.emplace_back([trimmed UTF8String]);
    }
    return cleaned;
}

static int32_t TextWeight(const std::string &text) {
    NSString *s = [NSString stringWithUTF8String:text.c_str()];
    if (s == nil || s.length == 0) {
        return 1;
    }
    return static_cast<int32_t>(MAX(1, static_cast<int32_t>(s.length)));
}

static std::vector<int32_t> DistributeSamplesByTextWeight(
    int32_t totalSamples,
    const std::vector<std::string> &segments
) {
    if (segments.empty()) {
        return {};
    }

    int32_t safeTotal = std::max<int32_t>(0, totalSamples);
    if (safeTotal == 0) {
        return std::vector<int32_t>(segments.size(), 0);
    }

    std::vector<int32_t> weights;
    weights.reserve(segments.size());
    int32_t weightSum = 0;
    for (const auto &segment : segments) {
        int32_t w = std::max<int32_t>(1, TextWeight(segment));
        weights.push_back(w);
        weightSum += w;
    }
    if (weightSum <= 0) {
        return std::vector<int32_t>(segments.size(), 0);
    }

    std::vector<int32_t> base(segments.size(), 0);
    std::vector<std::pair<size_t, double>> fractions;
    fractions.reserve(segments.size());

    for (size_t i = 0; i < segments.size(); ++i) {
        double exact = (static_cast<double>(safeTotal) * static_cast<double>(weights[i])) / static_cast<double>(weightSum);
        int32_t floorValue = static_cast<int32_t>(std::floor(exact));
        base[i] = floorValue;
        fractions.emplace_back(i, exact - static_cast<double>(floorValue));
    }

    int32_t assigned = 0;
    for (auto v : base) {
        assigned += v;
    }

    int32_t remaining = safeTotal - assigned;
    if (remaining > 0) {
        std::sort(
            fractions.begin(),
            fractions.end(),
            [](const auto &a, const auto &b) { return a.second > b.second; }
        );

        size_t ptr = 0;
        while (remaining > 0 && !fractions.empty()) {
            size_t idx = fractions[ptr % fractions.size()].first;
            base[idx] += 1;
            remaining -= 1;
            ptr += 1;
        }
    }

    return base;
}

static std::vector<int32_t> AlignChunkCountsToSegments(
    const std::vector<std::string> &segments,
    const std::vector<int32_t> &chunkSampleCounts
) {
    if (segments.empty()) {
        return {};
    }

    std::vector<int32_t> counts;
    counts.reserve(chunkSampleCounts.size());
    for (auto value : chunkSampleCounts) {
        counts.push_back(std::max<int32_t>(0, value));
    }

    if (counts.size() == segments.size()) {
        return counts;
    }

    if (counts.size() > segments.size()) {
        std::vector<int32_t> merged(counts.begin(), counts.begin() + static_cast<long>(segments.size()));
        int32_t extra = 0;
        for (size_t i = segments.size(); i < counts.size(); ++i) {
            extra += counts[i];
        }
        if (!merged.empty()) {
            merged.back() += extra;
        }
        return merged;
    }

    int32_t total = 0;
    for (auto value : counts) {
        total += value;
    }
    return DistributeSamplesByTextWeight(total, segments);
}

static std::vector<SubtitleTimingItem> BuildSubtitlesFromChunks(
    const std::vector<std::string> &segments,
    const std::vector<int32_t> &chunkSampleCounts,
    int32_t sampleRate
) {
    if (sampleRate <= 0) {
        return {};
    }

    std::vector<std::string> cleaned = SanitizeSegments(segments);
    if (cleaned.empty()) {
        return {};
    }

    std::vector<int32_t> aligned = AlignChunkCountsToSegments(cleaned, chunkSampleCounts);

    std::vector<SubtitleTimingItem> out;
    out.reserve(cleaned.size());
    int64_t offsetSamples = 0;

    for (size_t i = 0; i < cleaned.size(); ++i) {
        int32_t count = i < aligned.size() ? std::max<int32_t>(0, aligned[i]) : 0;
        if (count == 0 && offsetSamples == 0) {
            continue;
        }

        double start = static_cast<double>(offsetSamples) / static_cast<double>(sampleRate);
        offsetSamples += count;
        double end = static_cast<double>(offsetSamples) / static_cast<double>(sampleRate);

        out.push_back(SubtitleTimingItem{cleaned[i], start, end});
    }

    return out;
}

static std::vector<SubtitleTimingItem> BuildWordSubtitlesFromSentenceChunks(
    const std::vector<std::string> &sentences,
    const std::vector<int32_t> &sentenceChunkSampleCounts,
    int32_t sampleRate
);

static std::vector<std::string> SplitTextIntoSentences(const std::string &text) {
    NSString *source = [NSString stringWithUTF8String:text.c_str()];
    if (source == nil) {
        return {};
    }
    NSString *normalized = [source stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (normalized.length == 0) {
        return {};
    }

    NSCharacterSet *ws = [NSCharacterSet whitespaceAndNewlineCharacterSet];
    NSMutableArray<NSString *> *items = [NSMutableArray array];

    NSInteger start = 0;
    NSInteger i = 0;

    while (i < normalized.length) {
        unichar current = [normalized characterAtIndex:i];
        if (!IsSentenceTerminator(current)) {
            i += 1;
            continue;
        }

        if (current == '.' && !ShouldSplitOnPeriod(normalized, i)) {
            i += 1;
            continue;
        }

        NSInteger end = SentenceBoundaryEnd(normalized, i);
        if (end < normalized.length && ![ws characterIsMember:[normalized characterAtIndex:end]]) {
            i += 1;
            continue;
        }

        NSString *segment = [[normalized substringWithRange:NSMakeRange(start, end - start)]
            stringByTrimmingCharactersInSet:ws];
        if (segment.length > 0) {
            [items addObject:segment];
        }

        start = end;
        while (start < normalized.length && [ws characterIsMember:[normalized characterAtIndex:start]]) {
            start += 1;
        }
        i = start;
    }

    if (start < normalized.length) {
        NSString *tail = [[normalized substringFromIndex:start] stringByTrimmingCharactersInSet:ws];
        if (tail.length > 0) {
            [items addObject:tail];
        }
    }

    std::vector<std::string> out;
    out.reserve(items.count);
    for (NSString *segment in items) {
        out.emplace_back([segment UTF8String]);
    }

    if (out.empty()) {
        out.emplace_back([normalized UTF8String]);
    }
    return out;
}

static std::vector<std::string> SplitTextIntoWords(const std::string &text) {
    NSString *source = [NSString stringWithUTF8String:text.c_str()];
    if (source == nil) {
        return {};
    }
    NSString *normalized = [source stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (normalized.length == 0) {
        return {};
    }

    NSCharacterSet *ws = [NSCharacterSet whitespaceAndNewlineCharacterSet];
    NSMutableArray<NSString *> *items = [NSMutableArray array];
    NSMutableString *current = [NSMutableString string];

    void (^flushCurrent)(void) = ^{
        NSString *token = [current stringByTrimmingCharactersInSet:ws];
        if (token.length > 0) {
            [items addObject:token];
        }
        [current setString:@""];
    };

    for (NSInteger i = 0; i < normalized.length; ++i) {
        unichar c = [normalized characterAtIndex:i];
        if ([ws characterIsMember:c]) {
            flushCurrent();
            continue;
        }
        if (IsCjkCodepoint(c)) {
            flushCurrent();
            [items addObject:[NSString stringWithCharacters:&c length:1]];
            continue;
        }
        if (IsWordDelimiter(c)) {
            flushCurrent();
            continue;
        }
        [current appendFormat:@"%C", c];
    }

    flushCurrent();

    std::vector<std::string> out;
    out.reserve(items.count);
    for (NSString *segment in items) {
        out.emplace_back([segment UTF8String]);
    }
    if (out.empty()) {
        out.emplace_back([normalized UTF8String]);
    }
    return out;
}

static std::vector<SubtitleTimingItem> BuildWordSubtitlesFromSentenceChunks(
    const std::vector<std::string> &sentences,
    const std::vector<int32_t> &sentenceChunkSampleCounts,
    int32_t sampleRate
) {
    std::vector<std::string> cleanedSentences = SanitizeSegments(sentences);
    if (cleanedSentences.empty()) {
        return {};
    }

    std::vector<int32_t> alignedSentenceCounts = AlignChunkCountsToSegments(
        cleanedSentences,
        sentenceChunkSampleCounts
    );

    std::vector<std::string> wordSegments;
    std::vector<int32_t> wordChunkCounts;

    for (size_t i = 0; i < cleanedSentences.size(); ++i) {
        int32_t sentenceSamples = i < alignedSentenceCounts.size()
            ? std::max<int32_t>(0, alignedSentenceCounts[i])
            : 0;
        std::vector<std::string> words = SplitTextIntoWords(cleanedSentences[i]);
        if (words.empty()) {
            continue;
        }

        std::vector<int32_t> distributed = DistributeSamplesByTextWeight(sentenceSamples, words);
        for (size_t j = 0; j < words.size(); ++j) {
            wordSegments.push_back(words[j]);
            wordChunkCounts.push_back(j < distributed.size() ? distributed[j] : 0);
        }
    }

    return BuildSubtitlesFromChunks(wordSegments, wordChunkCounts, sampleRate);
}

static NSMutableArray *SubtitleTimingsToNSArray(const std::vector<SubtitleTimingItem> &items) {
    NSMutableArray *array = [NSMutableArray arrayWithCapacity:items.size()];
    for (const auto &item : items) {
        NSString *text = [NSString stringWithUTF8String:item.text.c_str()] ?: @"";
        NSDictionary *entry = @{
            @"text": text,
            @"start": @(item.start),
            @"end": @(item.end)
        };
        [array addObject:entry];
    }
    return array;
}

static NSString *SubtitleModeFromOptions(NSDictionary *options) {
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

static NSString *SubtitleGranularityFromOptions(NSDictionary *options) {
    NSString *raw = [options[@"subtitleGranularity"] isKindOfClass:[NSString class]] ? options[@"subtitleGranularity"] : nil;
    NSString *normalized = raw != nil
        ? [[raw lowercaseString] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]
        : @"sentence";

    if ([normalized isEqualToString:@"word"] || [normalized isEqualToString:@"sentence"]) {
        return normalized;
    }

    return @"sentence";
}

/** When options omit numSteps, matches Android SherpaOnnxTtsHelper / upstream GenerationConfig default. */
constexpr int32_t kDefaultVoiceCloneNumSteps = 5;

/** Non-null optional when referenceAudio is non-empty array and referenceSampleRate > 0. */
static std::optional<sherpaonnx::VoiceCloneOptions> VoiceCloneOptionsFromNSDictionary(NSDictionary *options, int32_t defaultNumSteps) {
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

static bool NSDictionaryHasValidReferenceAudio(NSDictionary *options) {
    auto o = VoiceCloneOptionsFromNSDictionary(options, 1);
    return o.has_value() && !o->reference_audio.empty() && o->reference_sample_rate > 0;
}

} // namespace

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
        if (!result.lexiconLanguageCandidates.empty()) {
            NSMutableArray *langCandidates = [NSMutableArray array];
            for (const auto& id : result.lexiconLanguageCandidates) {
                [langCandidates addObject:[NSString stringWithUTF8String:id.c_str()]];
            }
            resultDict[@"lexiconLanguageCandidates"] = langCandidates;
        }
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

        using Kind = sherpaonnx::TtsModelKind;
        Kind kind = wrapper->getModelKind();
        bool hasRef = NSDictionaryHasValidReferenceAudio(options);

        if (hasRef && kind != Kind::kZipvoice && kind != Kind::kPocket) {
            reject(@"TTS_GENERATE_ERROR", @"Reference audio is only supported for Zipvoice and Pocket TTS.", nil);
            return;
        }
        if (kind == Kind::kPocket && !hasRef) {
            reject(@"TTS_GENERATE_ERROR", @"Pocket TTS requires reference audio for voice cloning. Pass referenceAudio and referenceSampleRate (> 0) in options.", nil);
            return;
        }
        if (hasRef && kind == Kind::kZipvoice) {
            NSString *rt = options[@"referenceText"];
            NSString *trimmed = rt != nil ? [rt stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] : @"";
            if ([trimmed length] == 0) {
                reject(@"TTS_GENERATE_ERROR", @"Zipvoice voice cloning requires non-empty referenceText (transcript of reference audio).", nil);
                return;
            }
        }

        std::optional<sherpaonnx::VoiceCloneOptions> cloneOpt;
        if (hasRef) {
            cloneOpt = VoiceCloneOptionsFromNSDictionary(options, kDefaultVoiceCloneNumSteps);
        }

        auto result = wrapper->generate(
            textStr,
            static_cast<int32_t>(sid),
            static_cast<float>(speed),
            cloneOpt
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

    NSString *subtitleMode = SubtitleModeFromOptions(options);
    NSString *subtitleGranularity = SubtitleGranularityFromOptions(options);
    if ([subtitleMode isEqualToString:@"accurate"]) {
        reject(@"TTS_SUBTITLE_ERROR", @"Accurate subtitle mode is not yet implemented. Use 'fast' or 'off'.", nil);
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

        using Kind = sherpaonnx::TtsModelKind;
        Kind kind = wrapper->getModelKind();
        bool hasRef = NSDictionaryHasValidReferenceAudio(options);

        if (hasRef && kind != Kind::kZipvoice && kind != Kind::kPocket) {
            reject(@"TTS_GENERATE_ERROR", @"Reference audio is only supported for Zipvoice and Pocket TTS.", nil);
            return;
        }
        if (kind == Kind::kPocket && !hasRef) {
            reject(@"TTS_GENERATE_ERROR", @"Pocket TTS requires reference audio for voice cloning. Pass referenceAudio and referenceSampleRate (> 0) in options.", nil);
            return;
        }
        if (hasRef && kind == Kind::kZipvoice) {
            NSString *rt = options[@"referenceText"];
            NSString *trimmed = rt != nil ? [rt stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] : @"";
            if ([trimmed length] == 0) {
                reject(@"TTS_GENERATE_ERROR", @"Zipvoice voice cloning requires non-empty referenceText (transcript of reference audio).", nil);
                return;
            }
        }

        std::optional<sherpaonnx::VoiceCloneOptions> cloneOpt;
        if (hasRef) {
            cloneOpt = VoiceCloneOptionsFromNSDictionary(options, kDefaultVoiceCloneNumSteps);
        }

        std::vector<float> generatedSamples;
        int32_t sampleRate = 0;
        std::vector<int32_t> sentenceChunkSizes;

        if ([subtitleMode isEqualToString:@"off"]) {
            auto result = wrapper->generate(
                textStr,
                static_cast<int32_t>(sid),
                static_cast<float>(speed),
                cloneOpt
            );
            if (result.samples.empty() || result.sampleRate == 0) {
                NSString *errorMsg = @"Failed to generate speech or result is empty";
                RCTLogError(@"%@", errorMsg);
                reject(@"TTS_GENERATE_ERROR", errorMsg, nil);
                return;
            }
            generatedSamples = std::move(result.samples);
            sampleRate = result.sampleRate;
        } else {
            auto callback = [&generatedSamples, &sentenceChunkSizes](const float *samples, int32_t numSamples, float progress) -> int32_t {
                (void)progress;
                if (samples == nullptr || numSamples <= 0) {
                    return 1;
                }
                generatedSamples.insert(generatedSamples.end(), samples, samples + numSamples);
                sentenceChunkSizes.push_back(numSamples);
                return numSamples;
            };

            bool streamOk = cloneOpt.has_value()
                ? wrapper->generateStream(
                    textStr,
                    static_cast<int32_t>(sid),
                    static_cast<float>(speed),
                    callback,
                    cloneOpt
                  )
                : wrapper->generateStream(
                    textStr,
                    static_cast<int32_t>(sid),
                    static_cast<float>(speed),
                    callback
                  );

            sampleRate = wrapper->getSampleRate();
            if (!streamOk || generatedSamples.empty() || sampleRate == 0) {
                NSString *errorMsg = @"Failed to generate speech or result is empty";
                RCTLogError(@"%@", errorMsg);
                reject(@"TTS_GENERATE_ERROR", errorMsg, nil);
                return;
            }

            if (sentenceChunkSizes.empty()) {
                sentenceChunkSizes.push_back(static_cast<int32_t>(generatedSamples.size()));
            }
        }

        NSMutableArray *samplesArray = [NSMutableArray arrayWithCapacity:generatedSamples.size()];
        for (float sample : generatedSamples) {
            [samplesArray addObject:@(sample)];
        }

        NSMutableArray *subtitlesArray = [NSMutableArray array];
        NSString *timingMode = @"off";

        if (![subtitleMode isEqualToString:@"off"]) {
            std::vector<std::string> sentences = SplitTextIntoSentences(textStr);
            std::vector<SubtitleTimingItem> subtitleItems = [subtitleGranularity isEqualToString:@"word"]
                ? BuildWordSubtitlesFromSentenceChunks(sentences, sentenceChunkSizes, sampleRate)
                : BuildSubtitlesFromChunks(sentences, sentenceChunkSizes, sampleRate);

            subtitlesArray = SubtitleTimingsToNSArray(subtitleItems);
            timingMode = @"estimated";
        }

        NSDictionary *resultDict = @{
            @"samples": samplesArray,
            @"sampleRate": @(sampleRate),
            @"subtitles": subtitlesArray,
            @"timingMode": timingMode
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

    using Kind = sherpaonnx::TtsModelKind;
    Kind streamKind = instRef->wrapper->getModelKind();
    bool streamHasRef = NSDictionaryHasValidReferenceAudio(options);

    if (streamKind == Kind::kPocket && !streamHasRef) {
        std::lock_guard<std::mutex> lock(g_tts_mutex);
        auto it2 = g_tts_instances.find([instanceId UTF8String]);
        if (it2 != g_tts_instances.end()) {
            it2->second->streamRunning.store(false);
        }
        reject(@"TTS_STREAM_ERROR", @"Pocket TTS requires reference audio for voice cloning. Pass referenceAudio and referenceSampleRate (> 0) in options.", nil);
        return;
    }
    if (streamHasRef && streamKind == Kind::kZipvoice) {
        std::lock_guard<std::mutex> lock(g_tts_mutex);
        auto it2 = g_tts_instances.find([instanceId UTF8String]);
        if (it2 != g_tts_instances.end()) {
            it2->second->streamRunning.store(false);
        }
        reject(@"TTS_STREAM_ERROR", @"Streaming with reference audio not supported for Zipvoice", nil);
        return;
    }
    if (streamHasRef && streamKind != Kind::kPocket) {
        std::lock_guard<std::mutex> lock(g_tts_mutex);
        auto it2 = g_tts_instances.find([instanceId UTF8String]);
        if (it2 != g_tts_instances.end()) {
            it2->second->streamRunning.store(false);
        }
        reject(@"TTS_STREAM_ERROR", @"Reference audio streaming is only supported for Pocket TTS.", nil);
        return;
    }

    std::optional<sherpaonnx::VoiceCloneOptions> streamCloneOpt;
    if (streamHasRef) {
        streamCloneOpt = VoiceCloneOptionsFromNSDictionary(options, kDefaultVoiceCloneNumSteps);
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
                },
                streamCloneOpt
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

- (void)copyFileToContentUri:(NSString *)filePath
              directoryUri:(NSString *)directoryUri
                  filename:(NSString *)filename
                  mimeType:(NSString *)mimeType
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
    reject(@"TTS_SAVE_ERROR", @"Copy file to content URI is not supported on iOS (Android SAF only)", nil);
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
