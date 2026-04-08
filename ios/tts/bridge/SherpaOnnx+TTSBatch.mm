/**
 * SherpaOnnx+TTSBatch.mm — Offline batch generation and timestamped subtitles.
 */

#import "SherpaOnnx.h"
#import <React/RCTLog.h>

#include "engine/TtsEngineStore.h"
#include "options/TtsGenerationOptionsHelpers.h"
#include "native/sherpa-onnx-tts-wrapper.h"
#include "../pcm/PcmPlayerRegistry.h"

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

        // Sub-plan 01: store PCM in native sink
        it->second->sink.update(result.samples, result.sampleRate);
        uint64_t generation = it->second->sink.generation;

        // Sub-plan 02: metadata-only — no samples array over the bridge
        NSDictionary *resultDict = @{
            @"sampleRate": @(result.sampleRate),
            @"numSamples": @(static_cast<int32_t>(result.samples.size())),
            @"generation": @(static_cast<double>(generation))
        };

        RCTLogInfo(@"TTS: Generated %lu samples at %d Hz (generation %llu)",
                   (unsigned long)result.samples.size(), result.sampleRate, generation);

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

    NSString *subtitleMode = SubtitleModeFromOptions(options);
    if ([subtitleMode isEqualToString:@"accurate"]) {
        reject(@"TTS_SUBTITLE_ERROR",
               @"subtitleMode 'accurate' is handled via alignment.alignTextToTtsSink; generate audio and align from sink.",
               nil);
        return;
    }
    if (IsCharacterGranularityRequested(options) && ![subtitleMode isEqualToString:@"accurate"]) {
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

        // Sub-plan 01: store PCM in native sink
        it->second->sink.update(generatedSamples.data(), generatedSamples.size(), sampleRate);
        uint64_t generation = it->second->sink.generation;

        NSMutableDictionary *resultDict = [@{
            @"sampleRate": @(sampleRate),
            @"numSamples": @(static_cast<int32_t>(generatedSamples.size())),
            @"generation": @(static_cast<double>(generation)),
            @"subtitles": @[],
        } mutableCopy];

        if ([subtitleMode isEqualToString:@"estimated"]) {
            NSMutableArray *counts = [NSMutableArray arrayWithCapacity:sentenceChunkSizes.size()];
            for (int32_t c : sentenceChunkSizes) {
                [counts addObject:@(c)];
            }
            resultDict[@"segmentSampleCounts"] = counts;
        }
        if ([subtitleMode isEqualToString:@"off"]) {
            resultDict[@"timingMode"] = @"off";
        } else if ([subtitleMode isEqualToString:@"proportional"]) {
            resultDict[@"timingMode"] = @"proportional";
        } else {
            resultDict[@"timingMode"] = @"estimated";
        }

        resolve(resultDict);
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception during TTS generation: %@", exception.reason];
        RCTLogError(@"%@", errorMsg);
        reject(@"TTS_GENERATE_ERROR", errorMsg, nil);
    }
}

- (void)so_getTtsSamples:(NSString *)instanceId
              generation:(double)generation
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(@"TTS_INSTANCE_NOT_FOUND", @"instanceId is required", nil);
        return;
    }
    std::string instanceIdStr = [instanceId UTF8String];
    std::lock_guard<std::mutex> lock(g_tts_mutex);
    auto it = g_tts_instances.find(instanceIdStr);
    if (it == g_tts_instances.end()) {
        reject(@"TTS_INSTANCE_NOT_FOUND", @"TTS instance not found", nil);
        return;
    }
    auto &sink = it->second->sink;
    uint64_t requestedGen = static_cast<uint64_t>(generation);
    if (sink.generation == 0 || sink.samples.empty()) {
        reject(@"TTS_NO_SAMPLES", @"No batch synthesis result available", nil);
        return;
    }
    if (requestedGen != sink.generation) {
        NSString *msg = [NSString stringWithFormat:@"Generation %llu is stale; current is %llu",
                         (unsigned long long)requestedGen, (unsigned long long)sink.generation];
        reject(@"TTS_STALE_GENERATION", msg, nil);
        return;
    }
    NSMutableArray *samplesArray = [NSMutableArray arrayWithCapacity:sink.samples.size()];
    for (float s : sink.samples) {
        [samplesArray addObject:@(s)];
    }
    NSDictionary *result = @{
        @"samples": samplesArray,
        @"sampleRate": @(sink.sampleRate)
    };
    resolve(result);
}

- (void)so_saveTtsAudioFromSink:(NSString *)instanceId
                     generation:(double)generation
                destinationType:(NSString *)destinationType
             pathOrDirectoryUri:(NSString *)pathOrDirectoryUri
                       filename:(NSString *)filename
                         format:(NSString *)format
             outputSampleRateHz:(double)outputSampleRateHz
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(@"TTS_INSTANCE_NOT_FOUND", @"instanceId is required", nil);
        return;
    }
    std::string instanceIdStr = [instanceId UTF8String];
    NSMutableArray<NSNumber *> *samplesCopy;
    double sampleRate;
    {
        std::lock_guard<std::mutex> lock(g_tts_mutex);
        auto it = g_tts_instances.find(instanceIdStr);
        if (it == g_tts_instances.end()) {
            reject(@"TTS_INSTANCE_NOT_FOUND", @"TTS instance not found", nil);
            return;
        }
        auto &sink = it->second->sink;
        uint64_t requestedGen = static_cast<uint64_t>(generation);
        if (sink.generation == 0 || sink.samples.empty()) {
            reject(@"TTS_NO_SAMPLES", @"No batch synthesis result available", nil);
            return;
        }
        if (requestedGen != sink.generation) {
            NSString *msg = [NSString stringWithFormat:@"Generation %llu is stale; current is %llu",
                             (unsigned long long)requestedGen, (unsigned long long)sink.generation];
            reject(@"TTS_STALE_GENERATION", msg, nil);
            return;
        }
        samplesCopy = [NSMutableArray arrayWithCapacity:sink.samples.size()];
        for (float s : sink.samples) {
            [samplesCopy addObject:@(s)];
        }
        sampleRate = static_cast<double>(sink.sampleRate);
    }
    // Delegate to existing save implementation
    [self so_saveTtsAudioFromPCM:samplesCopy
               sampleRate:sampleRate
          destinationType:destinationType
       pathOrDirectoryUri:pathOrDirectoryUri
                 filename:filename
                   format:format
       outputSampleRateHz:outputSampleRateHz
                  resolve:resolve
                   reject:reject];
}

- (void)so_playTtsFromSink:(NSString *)instanceId
             generation:(double)generation
             sampleRate:(double)sampleRate
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(@"TTS_INSTANCE_NOT_FOUND", @"instanceId is required", nil);
        return;
    }

    std::vector<float> pcmCopy;
    int32_t rate = 0;
    std::string instanceIdStr = [instanceId UTF8String];

    {
        std::lock_guard<std::mutex> lock(g_tts_mutex);
        auto it = g_tts_instances.find(instanceIdStr);
        if (it == g_tts_instances.end() || it->second->wrapper == nullptr) {
            reject(@"TTS_NOT_INITIALIZED", @"TTS not initialized. Call initializeTts() first.", nil);
            return;
        }
        auto &sink = it->second->sink;
        if (sink.generation == 0 || sink.samples.empty()) {
            reject(@"TTS_SINK_EMPTY", @"No batch synthesis result available", nil);
            return;
        }
        uint64_t requestedGen = static_cast<uint64_t>(generation);
        if (requestedGen != sink.generation) {
            reject(@"TTS_SINK_STALE",
                   [NSString stringWithFormat:@"Generation %llu is stale; current is %llu",
                    requestedGen, sink.generation], nil);
            return;
        }
        pcmCopy = sink.samples;
        rate = (sampleRate > 0) ? static_cast<int32_t>(sampleRate) : sink.sampleRate;
    }

    // Auto-destroy previous batch playback player for this instance
    {
        std::lock_guard<std::mutex> lock(g_pcm_player_mutex);
        for (auto it = g_pcm_players.begin(); it != g_pcm_players.end(); ) {
            if (it->second && it->second->ttsInstanceId == instanceIdStr &&
                it->first.find("batch_play_") == 0) {
                it->second->destroy();
                it = g_pcm_players.erase(it);
            } else {
                ++it;
            }
        }
    }

    uint64_t requestedGen = static_cast<uint64_t>(generation);
    std::string playerId = "batch_play_" + instanceIdStr + "_" + std::to_string(requestedGen);

    auto session = std::make_shared<PcmPlayerSession>();
    session->playerId = playerId;
    session->sampleRate = rate;
    session->channels = 1;
    session->feed = PcmPlayerFeed::NATIVE;
    session->ttsInstanceId = instanceIdStr;

    AVAudioSession *audioSession = [AVAudioSession sharedInstance];
    [audioSession setCategory:AVAudioSessionCategoryPlayback error:nil];
    [audioSession setActive:YES error:nil];

    session->audioEngine = [[AVAudioEngine alloc] init];
    session->playerNode = [[AVAudioPlayerNode alloc] init];
    session->audioFormat = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:(double)rate channels:1];
    [session->audioEngine attachNode:session->playerNode];
    [session->audioEngine connect:session->playerNode to:session->audioEngine.mainMixerNode format:session->audioFormat];
    NSError *startError = nil;
    BOOL engineStarted = [session->audioEngine startAndReturnError:&startError];
    if (!engineStarted || startError) {
        reject(@"PCM_PLAYER_ERROR",
               [NSString stringWithFormat:@"Failed to start audio engine: %@", startError.localizedDescription ?: @"unknown error"],
               startError);
        return;
    }
    [session->playerNode play];

    {
        std::lock_guard<std::mutex> lock(g_pcm_player_mutex);
        g_pcm_players[playerId] = session;
    }

    session->enqueueMonoFloat32(pcmCopy.data(), static_cast<int32_t>(pcmCopy.size()));
    NSString *playerIdStr = [NSString stringWithUTF8String:playerId.c_str()];
    resolve(@{ @"playerId": playerIdStr });
}

@end
