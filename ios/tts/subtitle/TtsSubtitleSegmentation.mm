#import "TtsSubtitleSegmentation.h"

#import <Foundation/Foundation.h>

#include <algorithm>
#include <cmath>
#include <set>
#include <utility>
#include <vector>

namespace tts_subtitle {

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

    NSString *tokenRaw = [ExtractTokenBeforePeriod(text, periodIndex)
        stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    NSString *tokenLower = [tokenRaw lowercaseString];
    std::string tokenUtf8 = tokenLower != nil ? std::string([tokenLower UTF8String]) : std::string();
    if (!tokenUtf8.empty() && kAbbreviations.find(tokenUtf8) != kAbbreviations.end()) {
        return false;
    }

    if (tokenRaw.length == 1) {
        NSCharacterSet *upper = [NSCharacterSet uppercaseLetterCharacterSet];
        if ([upper characterIsMember:[tokenRaw characterAtIndex:0]]) {
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

std::vector<std::string> SplitTextIntoSentences(const std::string &text) {
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

std::vector<SubtitleTimingItem> BuildSubtitlesFromChunks(
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

std::vector<SubtitleTimingItem> BuildWordSubtitlesFromSentenceChunks(
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

NSMutableArray *SubtitleTimingsToNSArray(const std::vector<SubtitleTimingItem> &items) {
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

} // namespace tts_subtitle
