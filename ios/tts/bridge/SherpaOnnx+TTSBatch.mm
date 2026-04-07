/**
 * SherpaOnnx+TTSBatch.mm — Offline batch generation and timestamped subtitles.
 */

#import "SherpaOnnx.h"
#import <React/RCTLog.h>

#include "engine/TtsEngineStore.h"
#include "options/TtsGenerationOptionsHelpers.h"
#include "subtitle/TtsSubtitleSegmentation.h"
#include "native/sherpa-onnx-tts-wrapper.h"

#include <memory>
#include <optional>
#include <string>
#include <vector>

@implementation SherpaOnnx (TTSBatch)

- (void)so_generateTts:(NSString *)instanceId
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

- (void)so_generateTtsWithTimestamps:(NSString *)instanceId
                            text:(NSString *)text
                          options:(NSDictionary *)options
                     resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(@"TTS_GENERATE_ERROR", @"instanceId is required", nil);
        return;
    }

    BOOL exportChunkOnly = ExportChunkTimelineOnly(options);
    NSString *subtitleMode = SubtitleModeFromOptions(options);
    if (exportChunkOnly) {
        subtitleMode = @"estimated";
    }
    NSString *subtitleGranularity = SubtitleGranularityFromOptions(options);
    if (!exportChunkOnly && IsCharacterGranularityRequested(options) && ![subtitleMode isEqualToString:@"accurate"]) {
        reject(@"TTS_SUBTITLE_ERROR", @"Character granularity is only supported when subtitleMode is 'accurate'.", nil);
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

        if ([subtitleMode isEqualToString:@"off"] || [subtitleMode isEqualToString:@"proportional"]) {
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

        if (exportChunkOnly) {
            NSMutableArray *counts = [NSMutableArray arrayWithCapacity:sentenceChunkSizes.size()];
            for (int32_t c : sentenceChunkSizes) {
                [counts addObject:@(c)];
            }
            NSDictionary *resultDict = @{
                @"samples": samplesArray,
                @"sampleRate": @(sampleRate),
                @"segmentSampleCounts": counts,
                @"subtitles": @[],
                @"timingMode": @"estimated"
            };
            resolve(resultDict);
            return;
        }

        NSMutableArray *subtitlesArray = [NSMutableArray array];
        NSString *timingMode = @"off";

        if (![subtitleMode isEqualToString:@"off"]) {
            std::vector<std::string> sentences = tts_subtitle::SplitTextIntoSentences(textStr);
            std::vector<tts_subtitle::SubtitleTimingItem> subtitleItems = [subtitleGranularity isEqualToString:@"word"]
                ? tts_subtitle::BuildWordSubtitlesFromSentenceChunks(sentences, sentenceChunkSizes, sampleRate)
                : tts_subtitle::BuildSubtitlesFromChunks(sentences, sentenceChunkSizes, sampleRate);

            subtitlesArray = tts_subtitle::SubtitleTimingsToNSArray(subtitleItems);
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

@end
