/**
 * Subtitle timing from sentence/word chunks (parallel to Android SherpaOnnxTextSegmenter).
 */

#pragma once

#import <Foundation/Foundation.h>

#include <cstdint>
#include <string>
#include <vector>

namespace tts_subtitle {

struct SubtitleTimingItem {
    std::string text;
    double start = 0.0;
    double end = 0.0;
};

std::vector<std::string> SplitTextIntoSentences(const std::string &text);

std::vector<SubtitleTimingItem> BuildSubtitlesFromChunks(
    const std::vector<std::string> &segments,
    const std::vector<int32_t> &chunkSampleCounts,
    int32_t sampleRate
);

std::vector<SubtitleTimingItem> BuildWordSubtitlesFromSentenceChunks(
    const std::vector<std::string> &sentences,
    const std::vector<int32_t> &sentenceChunkSampleCounts,
    int32_t sampleRate
);

NSMutableArray *SubtitleTimingsToNSArray(const std::vector<SubtitleTimingItem> &items);

} // namespace tts_subtitle
