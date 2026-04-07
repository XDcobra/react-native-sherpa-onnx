/**
 * SherpaOnnx+TTSPcm.mm — PCM float playback via AVAudioEngine.
 */

#import "SherpaOnnx.h"
#import <React/RCTLog.h>
#import <AVFoundation/AVFoundation.h>

#include "engine/TtsEngineStore.h"

#include <mutex>
#include <string>

@implementation SherpaOnnx (TTSPcm)

- (void)so_startTtsPcmPlayer:(NSString *)instanceId
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

- (void)so_writeTtsPcmChunk:(NSString *)instanceId
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

- (void)so_stopTtsPcmPlayer:(NSString *)instanceId
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

@end
