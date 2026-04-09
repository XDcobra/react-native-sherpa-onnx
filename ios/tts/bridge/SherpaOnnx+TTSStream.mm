/**
 * SherpaOnnx+TTSStream.mm — Streaming synthesis and stream-to-file.
 */

#import "SherpaOnnx.h"
#import <React/RCTLog.h>

#include "engine/TtsEngineStore.h"
#include "options/TtsGenerationOptionsHelpers.h"
#include "wav/TtsStreamingWavSink.h"
#include "native/sherpa-onnx-tts-wrapper.h"
#include "../pcm/PcmPlayerRegistry.h"

#include <memory>
#include <mutex>
#include <optional>
#include <string>

// Helper: encode float PCM as base64 (little-endian, 4 bytes per sample).
// Replaces per-element NSNumber boxing with a single NSData→base64 call.
static NSString *pcmToBase64(const float *samples, int32_t numSamples) {
    if (samples == nullptr || numSamples <= 0) return @"";
    NSData *data = [NSData dataWithBytes:samples length:(NSUInteger)(numSamples * sizeof(float))];
    return [data base64EncodedStringWithOptions:0];
}

// Chunk coalescing thresholds — fewer, larger JS callbacks for long text.
static const int32_t kMaxFramesPerChunk = 16384;
static const int64_t kMaxChunkLatencyNs = 500LL * 1000000LL; // 500 ms

@implementation SherpaOnnx (TTSStream)

- (void)so_generateTtsStream:(NSString *)instanceId
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
    BOOL playback = NO;
    BOOL emitChunks = YES;
    BOOL autoDestroy = YES;
    if (options != nil) {
        if (options[@"sid"] != nil) sid = [options[@"sid"] doubleValue];
        if (options[@"speed"] != nil) speed = [options[@"speed"] doubleValue];
        if (options[@"playback"] != nil) playback = [options[@"playback"] boolValue];
        if (options[@"emitChunks"] != nil) emitChunks = [options[@"emitChunks"] boolValue];
        if (options[@"autoDestroy"] != nil) autoDestroy = [options[@"autoDestroy"] boolValue];
    }
    if (!playback && !emitChunks) {
        reject(@"TTS_STREAM_ERROR", @"emitChunks=false + playback=false is a no-op", nil);
        return;
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
        instRef = it->second;
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

        // Native playback player (if playback == YES)
        std::shared_ptr<PcmPlayerSession> playbackSession = nullptr;
        std::string playbackPlayerId;
        if (playback) {
            playbackPlayerId = std::string([instanceIdCopy UTF8String]) + "_" + (requestIdCopy ? [requestIdCopy UTF8String] : "anon");
            playbackPlayerId = "tts_playback_" + playbackPlayerId;

            auto session = std::make_shared<PcmPlayerSession>();
            session->playerId = playbackPlayerId;
            session->sampleRate = sampleRate;
            session->channels = 1;
            session->feed = PcmPlayerFeed::NATIVE;
            session->ttsInstanceId = [instanceIdCopy UTF8String];

            AVAudioSession *audioSession = [AVAudioSession sharedInstance];
            [audioSession setCategory:AVAudioSessionCategoryPlayback error:nil];
            [audioSession setActive:YES error:nil];

            session->audioEngine = [[AVAudioEngine alloc] init];
            session->playerNode = [[AVAudioPlayerNode alloc] init];
            session->audioFormat = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:(double)sampleRate channels:1];
            [session->audioEngine attachNode:session->playerNode];
            [session->audioEngine connect:session->playerNode to:session->audioEngine.mainMixerNode format:session->audioFormat];
            NSError *startError = nil;
            BOOL engineStarted = [session->audioEngine startAndReturnError:&startError];
            if (!engineStarted || startError) {
                NSLog(@"[SherpaOnnx] TTS stream playback: failed to start audio engine: %@", startError.localizedDescription ?: @"unknown error");
                // Proceed without playback — stream will still emit chunks if emitChunks is set
                playbackPlayerId = "";
            } else {
                [session->playerNode play];
                {
                    std::lock_guard<std::mutex> lock(g_pcm_player_mutex);
                    g_pcm_players[session->playerId] = session;
                }
                playbackSession = session;
            }
        }

        // Coalescing buffer — accumulates native ticks and flushes as fewer, larger chunks.
        __block std::vector<float> coalesceBuffer;
        __block int64_t coalesceFirstNs = 0;
        __block float lastProgress = 0.0f;

        auto flushCoalesceBuffer = [&coalesceBuffer, &coalesceFirstNs, &lastProgress, sampleRate, instanceIdCopy, requestIdCopy, weakSelf]() {
            if (coalesceBuffer.empty()) return;
            NSString *pcmB64 = pcmToBase64(coalesceBuffer.data(), (int32_t)coalesceBuffer.size());
            float progressSnapshot = lastProgress;
            NSMutableDictionary *payload = [NSMutableDictionary dictionaryWithDictionary:@{
                @"instanceId": instanceIdCopy,
                @"pcmBase64": pcmB64,
                @"sampleRate": @(sampleRate),
                @"progress": @(progressSnapshot),
                @"isFinal": @NO
            }];
            if (requestIdCopy != nil) payload[@"requestId"] = requestIdCopy;
            dispatch_async(dispatch_get_main_queue(), ^{
                if (weakSelf) {
                    [weakSelf sendEventWithName:@"ttsStreamChunk" body:payload];
                }
            });
            coalesceBuffer.clear();
            coalesceFirstNs = 0;
        };

        @try {
            success = instRef->wrapper->generateStream(
                textStr,
                static_cast<int32_t>(sid),
                static_cast<float>(speed),
                [&coalesceBuffer, &coalesceFirstNs, &lastProgress, &flushCoalesceBuffer, emitChunks, &playbackSession, instRef](const float *samples, int32_t numSamples, float progress) -> int32_t {
                    if (instRef->streamCancelled.load()) {
                        return 0;
                    }

                    if (playbackSession) playbackSession->enqueueMonoFloat32(samples, numSamples);

                    if (emitChunks) {
                        lastProgress = progress;
                        if (coalesceBuffer.empty()) coalesceFirstNs = clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW);
                        coalesceBuffer.insert(coalesceBuffer.end(), samples, samples + numSamples);
                        if ((int32_t)coalesceBuffer.size() >= kMaxFramesPerChunk ||
                            (clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) - coalesceFirstNs) >= (uint64_t)kMaxChunkLatencyNs) {
                            flushCoalesceBuffer();
                        }
                    }

                    return instRef->streamCancelled.load() ? 0 : 1;
                },
                streamCloneOpt
            );
        } @catch (NSException *exception) {
            NSString *errorMsg = [NSString stringWithFormat:@"TTS streaming failed: %@", exception.reason];
            NSMutableDictionary *errPayload = [NSMutableDictionary dictionaryWithDictionary:@{ @"instanceId": instanceIdCopy, @"message": errorMsg }];
            if (requestIdCopy != nil) errPayload[@"requestId"] = requestIdCopy;
            if (playbackSession) {
                std::lock_guard<std::mutex> lock(g_pcm_player_mutex);
                g_pcm_players.erase(playbackSession->playerId);
                playbackSession->destroy();
            }
            dispatch_async(dispatch_get_main_queue(), ^{
                if (weakSelf) {
                    [weakSelf sendEventWithName:@"ttsStreamError" body:errPayload];
                }
            });
        }

        bool cancelled = instRef->streamCancelled.load();

        // Destroy playback player if autoDestroy or cancelled
        if (playbackSession && (autoDestroy || cancelled)) {
            std::lock_guard<std::mutex> lock(g_pcm_player_mutex);
            g_pcm_players.erase(playbackSession->playerId);
            playbackSession->destroy();
        }

        if (!success && !cancelled) {
            NSMutableDictionary *errPayload = [NSMutableDictionary dictionaryWithDictionary:@{ @"instanceId": instanceIdCopy, @"message": @"TTS streaming generation failed" }];
            if (requestIdCopy != nil) errPayload[@"requestId"] = requestIdCopy;
            dispatch_async(dispatch_get_main_queue(), ^{
                if (weakSelf) {
                    [weakSelf sendEventWithName:@"ttsStreamError" body:errPayload];
                }
            });
        }

        if (!cancelled && emitChunks) {
            flushCoalesceBuffer();
            NSMutableDictionary *finalPayload = [NSMutableDictionary dictionaryWithDictionary:@{
                @"instanceId": instanceIdCopy,
                @"pcmBase64": @"",
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

- (void)so_generateTtsStreamToFile:(NSString *)instanceId
                      requestId:(NSString *)requestId
                           text:(NSString *)text
                        options:(NSDictionary *)options
                    fileOptions:(NSDictionary *)fileOptions
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(@"TTS_STREAM_FILE_ERROR", @"instanceId is required", nil);
        return;
    }
    NSDictionary *output = [fileOptions[@"output"] isKindOfClass:[NSDictionary class]] ? fileOptions[@"output"] : nil;
    NSString *path = [output[@"path"] isKindOfClass:[NSString class]] ? output[@"path"] : nil;
    if (path == nil || path.length == 0) {
        reject(@"TTS_STREAM_FILE_ERROR", @"fileOptions.output.path is required", nil);
        return;
    }
    NSString *format = [fileOptions[@"format"] isKindOfClass:[NSString class]] ? [fileOptions[@"format"] lowercaseString] : @"wav";
    if (![format isEqualToString:@"wav"]) {
        reject(@"TTS_STREAM_FILE_ERROR", @"Unsupported stream-to-file format (v1 supports wav)", nil);
        return;
    }
    BOOL keepPartialOnCancel = [fileOptions[@"keepPartialOnCancel"] boolValue];
    BOOL emitChunks = [fileOptions[@"emitChunks"] boolValue];

    double sid = options[@"sid"] != nil ? [options[@"sid"] doubleValue] : 0;
    double speed = options[@"speed"] != nil ? [options[@"speed"] doubleValue] : 1.0;
    BOOL playback = options[@"playback"] != nil ? [options[@"playback"] boolValue] : NO;
    BOOL autoDestroy = options[@"autoDestroy"] != nil ? [options[@"autoDestroy"] boolValue] : YES;

    std::string instanceIdStr = [instanceId UTF8String];
    std::shared_ptr<TtsInstanceState> instRef;
    {
        std::lock_guard<std::mutex> lock(g_tts_mutex);
        auto it = g_tts_instances.find(instanceIdStr);
        if (it == g_tts_instances.end() || it->second->wrapper == nullptr || !it->second->wrapper->isInitialized()) {
            reject(@"TTS_NOT_INITIALIZED", @"TTS not initialized. Call initializeTts() first.", nil);
            return;
        }
        instRef = it->second;
        if (instRef->streamRunning.load()) {
            reject(@"TTS_STREAM_FILE_ERROR", @"TTS streaming already in progress", nil);
            return;
        }
        instRef->streamCancelled.store(false);
        instRef->streamRunning.store(true);
    }

    int32_t sampleRate = instRef->wrapper->getSampleRate();
    NSString *instanceIdCopy = [instanceId copy];
    NSString *requestIdCopy = (requestId != nil && [requestId length] > 0) ? [requestId copy] : nil;
    NSString *pathCopy = [path copy];
    std::string textStr = [text UTF8String];

    __weak SherpaOnnx *weakSelf = self;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        std::unique_ptr<StreamingWavSink> sink;
        bool success = false;
        bool cancelled = false;
        int64_t bytesWritten = 0;

        // Native playback player (if playback == YES)
        std::shared_ptr<PcmPlayerSession> playbackSession = nullptr;
        std::string playbackPlayerId;
        if (playback) {
            playbackPlayerId = std::string([instanceIdCopy UTF8String]) + "_file_" + (requestIdCopy ? [requestIdCopy UTF8String] : "anon");
            playbackPlayerId = "tts_playback_" + playbackPlayerId;

            auto session = std::make_shared<PcmPlayerSession>();
            session->playerId = playbackPlayerId;
            session->sampleRate = sampleRate;
            session->channels = 1;
            session->feed = PcmPlayerFeed::NATIVE;
            session->ttsInstanceId = [instanceIdCopy UTF8String];

            AVAudioSession *audioSession = [AVAudioSession sharedInstance];
            [audioSession setCategory:AVAudioSessionCategoryPlayback error:nil];
            [audioSession setActive:YES error:nil];

            session->audioEngine = [[AVAudioEngine alloc] init];
            session->playerNode = [[AVAudioPlayerNode alloc] init];
            session->audioFormat = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:(double)sampleRate channels:1];
            [session->audioEngine attachNode:session->playerNode];
            [session->audioEngine connect:session->playerNode to:session->audioEngine.mainMixerNode format:session->audioFormat];
            NSError *startError = nil;
            BOOL engineStarted = [session->audioEngine startAndReturnError:&startError];
            if (!engineStarted || startError) {
                NSLog(@"[SherpaOnnx] TTS stream-to-file playback: failed to start audio engine: %@", startError.localizedDescription ?: @"unknown error");
                // Proceed without playback — file will still be written
                playbackPlayerId = "";
            } else {
                [session->playerNode play];
                {
                    std::lock_guard<std::mutex> lock(g_pcm_player_mutex);
                    g_pcm_players[session->playerId] = session;
                }
                playbackSession = session;
            }
        }

        // Coalescing buffer for chunk emission (only used when emitChunks == true).
        __block std::vector<float> coalesceBuffer;
        __block int64_t coalesceFirstNs = 0;
        __block float lastFileProgress = 0.0f;
        auto flushFileCoalesce = [&coalesceBuffer, &coalesceFirstNs, &lastFileProgress, sampleRate, instanceIdCopy, requestIdCopy, weakSelf]() {
            if (coalesceBuffer.empty()) return;
            NSString *pcmB64 = pcmToBase64(coalesceBuffer.data(), (int32_t)coalesceBuffer.size());
            float progressSnapshot = lastFileProgress;
            NSMutableDictionary *payload = [NSMutableDictionary dictionaryWithDictionary:@{
                @"instanceId": instanceIdCopy,
                @"pcmBase64": pcmB64,
                @"sampleRate": @(sampleRate),
                @"progress": @(progressSnapshot),
                @"isFinal": @NO
            }];
            if (requestIdCopy != nil) payload[@"requestId"] = requestIdCopy;
            dispatch_async(dispatch_get_main_queue(), ^{
                if (weakSelf) {
                    [weakSelf sendEventWithName:@"ttsStreamChunk" body:payload];
                }
            });
            coalesceBuffer.clear();
            coalesceFirstNs = 0;
        };

        @try {
            sink = std::make_unique<StreamingWavSink>(std::string([pathCopy UTF8String]), sampleRate);
            success = instRef->wrapper->generateStream(
                textStr,
                static_cast<int32_t>(sid),
                static_cast<float>(speed),
                [&coalesceBuffer, &coalesceFirstNs, &lastFileProgress, &flushFileCoalesce, emitChunks, &playbackSession, instRef, sinkPtr = sink.get()](const float *samples, int32_t numSamples, float progress) -> int32_t {
                    if (instRef->streamCancelled.load()) {
                        return 0;
                    }
                    sinkPtr->writeChunk(samples, numSamples);
                    if (playbackSession) playbackSession->enqueueMonoFloat32(samples, numSamples);
                    if (emitChunks) {
                        lastFileProgress = progress;
                        if (coalesceBuffer.empty()) coalesceFirstNs = clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW);
                        coalesceBuffer.insert(coalesceBuffer.end(), samples, samples + numSamples);
                        if ((int32_t)coalesceBuffer.size() >= kMaxFramesPerChunk ||
                            (clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) - coalesceFirstNs) >= (uint64_t)kMaxChunkLatencyNs) {
                            flushFileCoalesce();
                        }
                    }
                    return instRef->streamCancelled.load() ? 0 : 1;
                }
            );
            cancelled = instRef->streamCancelled.load();
            if (cancelled && !keepPartialOnCancel) {
                sink->abort(true);
            } else {
                bytesWritten = sink->finalize();
            }
        } @catch (NSException *exception) {
            cancelled = instRef->streamCancelled.load();
            if (sink) sink->abort(!keepPartialOnCancel);
            if (playbackSession) {
                std::lock_guard<std::mutex> lock(g_pcm_player_mutex);
                g_pcm_players.erase(playbackSession->playerId);
                playbackSession->destroy();
            }
            NSMutableDictionary *errPayload = [NSMutableDictionary dictionaryWithDictionary:@{
                @"instanceId": instanceIdCopy,
                @"message": [NSString stringWithFormat:@"TTS stream-to-file failed: %@", exception.reason ?: @"unknown error"]
            }];
            if (requestIdCopy != nil) errPayload[@"requestId"] = requestIdCopy;
            errPayload[@"path"] = pathCopy;
            dispatch_async(dispatch_get_main_queue(), ^{
                if (weakSelf) {
                    [weakSelf sendEventWithName:@"ttsStreamFileError" body:errPayload];
                }
            });
        }

        // Destroy playback player if autoDestroy or cancelled
        if (playbackSession && (autoDestroy || cancelled)) {
            std::lock_guard<std::mutex> lock(g_pcm_player_mutex);
            g_pcm_players.erase(playbackSession->playerId);
            playbackSession->destroy();
        }

        if (!success && !cancelled) {
            NSMutableDictionary *errPayload = [NSMutableDictionary dictionaryWithDictionary:@{
                @"instanceId": instanceIdCopy,
                @"message": @"TTS stream-to-file generation failed",
                @"path": pathCopy
            }];
            if (requestIdCopy != nil) errPayload[@"requestId"] = requestIdCopy;
            dispatch_async(dispatch_get_main_queue(), ^{
                if (weakSelf) {
                    [weakSelf sendEventWithName:@"ttsStreamFileError" body:errPayload];
                }
            });
        }

        if (emitChunks && !cancelled) {
            flushFileCoalesce();
            NSMutableDictionary *finalPayload = [NSMutableDictionary dictionaryWithDictionary:@{
                @"instanceId": instanceIdCopy,
                @"pcmBase64": @"",
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

        NSMutableDictionary *fileEndPayload = [NSMutableDictionary dictionaryWithDictionary:@{
            @"instanceId": instanceIdCopy,
            @"cancelled": @(cancelled),
            @"path": pathCopy,
            @"bytesWritten": @(bytesWritten),
            @"sampleRate": @(sampleRate)
        }];
        if (requestIdCopy != nil) fileEndPayload[@"requestId"] = requestIdCopy;
        dispatch_async(dispatch_get_main_queue(), ^{
            if (weakSelf) {
                [weakSelf sendEventWithName:@"ttsStreamFileEnd" body:fileEndPayload];
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

- (void)so_cancelTtsStream:(NSString *)instanceId
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

@end
