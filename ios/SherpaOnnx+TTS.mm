#import "SherpaOnnx.h"
#import <React/RCTLog.h>
#import <React/RCTUtils.h>
#import <UIKit/UIKit.h>
#import <AVFoundation/AVFoundation.h>

#include "sherpa-onnx-tts-wrapper.h"
#include <atomic>
#include <memory>
#include <string>

// Global TTS wrapper instance
static std::unique_ptr<sherpaonnx::TtsWrapper> g_tts_wrapper = nullptr;
static std::atomic<bool> g_tts_stream_running{false};
static std::atomic<bool> g_tts_stream_cancelled{false};
static AVAudioEngine *g_tts_engine = nil;
static AVAudioPlayerNode *g_tts_player = nil;
static AVAudioFormat *g_tts_format = nil;

@implementation SherpaOnnx (TTS)

- (void)initializeTts:(NSString *)modelDir
            modelType:(NSString *)modelType
           numThreads:(double)numThreads
                debug:(BOOL)debug
         withResolver:(RCTPromiseResolveBlock)resolve
         withRejecter:(RCTPromiseRejectBlock)reject
{
    RCTLogInfo(@"Initializing TTS with modelDir: %@, modelType: %@", modelDir, modelType);

    @try {
        if (g_tts_wrapper == nullptr) {
            g_tts_wrapper = std::make_unique<sherpaonnx::TtsWrapper>();
        }

        std::string modelDirStr = [modelDir UTF8String];
        std::string modelTypeStr = [modelType UTF8String];

        sherpaonnx::TtsInitializeResult result = g_tts_wrapper->initialize(
            modelDirStr,
            modelTypeStr,
            static_cast<int32_t>(numThreads),
            debug
        );

        if (result.success) {
            RCTLogInfo(@"TTS initialization successful");

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
            NSString *errorMsg = @"Failed to initialize TTS";
            RCTLogError(@"%@", errorMsg);
            reject(@"TTS_INIT_ERROR", errorMsg, nil);
        }
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception during TTS init: %@", exception.reason];
        RCTLogError(@"%@", errorMsg);
        reject(@"TTS_INIT_ERROR", errorMsg, nil);
    }
}

- (void)generateTts:(NSString *)text
                sid:(double)sid
              speed:(double)speed
       withResolver:(RCTPromiseResolveBlock)resolve
       withRejecter:(RCTPromiseRejectBlock)reject
{
    @try {
        if (g_tts_wrapper == nullptr || !g_tts_wrapper->isInitialized()) {
            NSString *errorMsg = @"TTS not initialized. Call initializeTts() first.";
            RCTLogError(@"%@", errorMsg);
            reject(@"TTS_NOT_INITIALIZED", errorMsg, nil);
            return;
        }

        std::string textStr = [text UTF8String];

        auto result = g_tts_wrapper->generate(
            textStr,
            static_cast<int32_t>(sid),
            static_cast<float>(speed)
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

- (void)generateTtsStream:(NSString *)text
                      sid:(double)sid
                    speed:(double)speed
             withResolver:(RCTPromiseResolveBlock)resolve
             withRejecter:(RCTPromiseRejectBlock)reject
{
    if (g_tts_stream_running.load()) {
        reject(@"TTS_STREAM_ERROR", @"TTS streaming already in progress", nil);
        return;
    }

    if (g_tts_wrapper == nullptr || !g_tts_wrapper->isInitialized()) {
        reject(@"TTS_NOT_INITIALIZED", @"TTS not initialized. Call initializeTts() first.", nil);
        return;
    }

    g_tts_stream_cancelled.store(false);
    g_tts_stream_running.store(true);

    std::string textStr = [text UTF8String];
    int32_t sampleRate = g_tts_wrapper->getSampleRate();

    __weak SherpaOnnx *weakSelf = self;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        bool success = false;
        @try {
            success = g_tts_wrapper->generateStream(
                textStr,
                static_cast<int32_t>(sid),
                static_cast<float>(speed),
                [weakSelf, sampleRate](const float *samples, int32_t numSamples, float progress) -> int32_t {
                    if (g_tts_stream_cancelled.load()) {
                        return 0;
                    }

                    NSMutableArray *samplesArray = [NSMutableArray arrayWithCapacity:numSamples];
                    for (int32_t i = 0; i < numSamples; i++) {
                        [samplesArray addObject:@(samples[i])];
                    }

                    NSDictionary *payload = @{
                        @"samples": samplesArray,
                        @"sampleRate": @(sampleRate),
                        @"progress": @(progress),
                        @"isFinal": @NO
                    };

                    dispatch_async(dispatch_get_main_queue(), ^{
                        if (weakSelf) {
                            [weakSelf sendEventWithName:@"ttsStreamChunk" body:payload];
                        }
                    });

                    return g_tts_stream_cancelled.load() ? 0 : 1;
                }
            );
        } @catch (NSException *exception) {
            NSString *errorMsg = [NSString stringWithFormat:@"TTS streaming failed: %@", exception.reason];
            dispatch_async(dispatch_get_main_queue(), ^{
                if (weakSelf) {
                    [weakSelf sendEventWithName:@"ttsStreamError" body:@{ @"message": errorMsg }];
                }
            });
        }

        bool cancelled = g_tts_stream_cancelled.load();
        if (!success && !cancelled) {
            dispatch_async(dispatch_get_main_queue(), ^{
                if (weakSelf) {
                    [weakSelf sendEventWithName:@"ttsStreamError" body:@{ @"message": @"TTS streaming generation failed" }];
                }
            });
        }

        dispatch_async(dispatch_get_main_queue(), ^{
            if (weakSelf) {
                [weakSelf sendEventWithName:@"ttsStreamEnd" body:@{ @"cancelled": @(cancelled) }];
            }
        });

        g_tts_stream_running.store(false);
    });

    resolve(nil);
}

- (void)cancelTtsStream:(RCTPromiseResolveBlock)resolve
           withRejecter:(RCTPromiseRejectBlock)reject
{
    @try {
        g_tts_stream_cancelled.store(true);
        resolve(nil);
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Failed to cancel TTS stream: %@", exception.reason];
        reject(@"TTS_STREAM_ERROR", errorMsg, nil);
    }
}

- (void)startTtsPcmPlayer:(double)sampleRate
                 channels:(double)channels
             withResolver:(RCTPromiseResolveBlock)resolve
             withRejecter:(RCTPromiseRejectBlock)reject
{
    dispatch_async(dispatch_get_main_queue(), ^{
        @try {
            if (channels != 1.0) {
                reject(@"TTS_PCM_ERROR", @"PCM playback supports mono only", nil);
                return;
            }
            [self stopTtsPcmPlayer:^(__unused id result) {}
                       withRejecter:^(__unused NSString *code, __unused NSString *message, __unused NSError *error) {}];

            AVAudioSession *session = [AVAudioSession sharedInstance];
            [session setCategory:AVAudioSessionCategoryPlayback error:nil];
            [session setActive:YES error:nil];

            g_tts_engine = [[AVAudioEngine alloc] init];
            g_tts_player = [[AVAudioPlayerNode alloc] init];

            g_tts_format = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:sampleRate channels:1];

            [g_tts_engine attachNode:g_tts_player];
            [g_tts_engine connect:g_tts_player to:g_tts_engine.mainMixerNode format:g_tts_format];

            NSError *startError = nil;
            if (![g_tts_engine startAndReturnError:&startError]) {
                NSString *errorMsg = [NSString stringWithFormat:@"Failed to start audio engine: %@", startError.localizedDescription];
                reject(@"TTS_PCM_ERROR", errorMsg, startError);
                return;
            }

            [g_tts_player play];
            resolve(nil);
        } @catch (NSException *exception) {
            NSString *errorMsg = [NSString stringWithFormat:@"Failed to start PCM player: %@", exception.reason];
            reject(@"TTS_PCM_ERROR", errorMsg, nil);
        }
    });
}

- (void)writeTtsPcmChunk:(NSArray<NSNumber *> *)samples
            withResolver:(RCTPromiseResolveBlock)resolve
            withRejecter:(RCTPromiseRejectBlock)reject
{
    @try {
        if (g_tts_engine == nil || g_tts_player == nil || g_tts_format == nil) {
            reject(@"TTS_PCM_ERROR", @"PCM player not initialized", nil);
            return;
        }

        AVAudioFrameCount frameCount = (AVAudioFrameCount)[samples count];
        AVAudioPCMBuffer *buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:g_tts_format frameCapacity:frameCount];
        buffer.frameLength = frameCount;

        float *channelData = buffer.floatChannelData[0];
        for (NSUInteger i = 0; i < [samples count]; i++) {
            channelData[i] = [samples[i] floatValue];
        }

        [g_tts_player scheduleBuffer:buffer completionHandler:nil];
        resolve(nil);
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Failed to write PCM chunk: %@", exception.reason];
        reject(@"TTS_PCM_ERROR", errorMsg, nil);
    }
}

- (void)stopTtsPcmPlayer:(RCTPromiseResolveBlock)resolve
            withRejecter:(RCTPromiseRejectBlock)reject
{
    dispatch_async(dispatch_get_main_queue(), ^{
        @try {
            if (g_tts_player != nil) {
                [g_tts_player stop];
            }
            if (g_tts_engine != nil) {
                [g_tts_engine stop];
                [g_tts_engine reset];
            }
            g_tts_player = nil;
            g_tts_engine = nil;
            g_tts_format = nil;
            resolve(nil);
        } @catch (NSException *exception) {
            NSString *errorMsg = [NSString stringWithFormat:@"Failed to stop PCM player: %@", exception.reason];
            reject(@"TTS_PCM_ERROR", errorMsg, nil);
        }
    });
}

- (void)getTtsSampleRate:(RCTPromiseResolveBlock)resolve
            withRejecter:(RCTPromiseRejectBlock)reject
{
    @try {
        if (g_tts_wrapper == nullptr || !g_tts_wrapper->isInitialized()) {
            NSString *errorMsg = @"TTS not initialized. Call initializeTts() first.";
            reject(@"TTS_NOT_INITIALIZED", errorMsg, nil);
            return;
        }

        int32_t sampleRate = g_tts_wrapper->getSampleRate();
        resolve(@(sampleRate));
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception getting sample rate: %@", exception.reason];
        reject(@"TTS_ERROR", errorMsg, nil);
    }
}

- (void)getTtsNumSpeakers:(RCTPromiseResolveBlock)resolve
             withRejecter:(RCTPromiseRejectBlock)reject
{
    @try {
        if (g_tts_wrapper == nullptr || !g_tts_wrapper->isInitialized()) {
            NSString *errorMsg = @"TTS not initialized. Call initializeTts() first.";
            reject(@"TTS_NOT_INITIALIZED", errorMsg, nil);
            return;
        }

        int32_t numSpeakers = g_tts_wrapper->getNumSpeakers();
        resolve(@(numSpeakers));
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception getting num speakers: %@", exception.reason];
        reject(@"TTS_ERROR", errorMsg, nil);
    }
}

- (void)unloadTts:(RCTPromiseResolveBlock)resolve
     withRejecter:(RCTPromiseRejectBlock)reject
{
    @try {
        [self stopTtsPcmPlayer:^(__unused id result) {}
               withRejecter:^(__unused NSString *code, __unused NSString *message, __unused NSError *error) {}];
        if (g_tts_wrapper != nullptr) {
            g_tts_wrapper->release();
            g_tts_wrapper.reset();
            g_tts_wrapper = nullptr;
        }
        RCTLogInfo(@"TTS resources released");
        resolve(nil);
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception during TTS cleanup: %@", exception.reason];
        RCTLogError(@"%@", errorMsg);
        reject(@"TTS_CLEANUP_ERROR", errorMsg, nil);
    }
}

- (void)saveTtsAudioToFile:(NSArray<NSNumber *> *)samples
             withSampleRate:(double)sampleRate
               withFilePath:(NSString *)filePath
               withResolver:(RCTPromiseResolveBlock)resolve
               withRejecter:(RCTPromiseRejectBlock)reject
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

- (void)shareTtsAudio:(NSString *)fileUri
            mimeType:(NSString *)mimeType
         withResolver:(RCTPromiseResolveBlock)resolve
         withRejecter:(RCTPromiseRejectBlock)reject
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
