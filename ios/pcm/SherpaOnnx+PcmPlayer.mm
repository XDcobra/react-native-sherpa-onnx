/**
 * SherpaOnnx+PcmPlayer.mm — Standalone PCM player bridge methods.
 */

#import "SherpaOnnx.h"
#import <React/RCTLog.h>
#import <AVFoundation/AVFoundation.h>

#include "PcmPlayerRegistry.h"

#include <memory>
#include <mutex>
#include <string>

@implementation SherpaOnnx (PcmPlayer)

- (void)so_createPcmPlayer:(NSString *)playerId
                sampleRate:(double)sampleRate
                  channels:(double)channels
                      feed:(NSString *)feed
             ttsInstanceId:(NSString *)ttsInstanceId
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
    if (playerId == nil || [playerId length] == 0) {
        reject(@"PCM_PLAYER_INVALID_CONFIG", @"playerId is required", nil);
        return;
    }
    int32_t sr = (int32_t)sampleRate;
    int32_t ch = (int32_t)channels;
    if (sr <= 0) {
        reject(@"PCM_PLAYER_INVALID_CONFIG", @"sampleRate must be > 0", nil);
        return;
    }
    if (ch != 1) {
        reject(@"PCM_PLAYER_INVALID_CONFIG", @"PCM playback supports mono only (channels=1)", nil);
        return;
    }
    PcmPlayerFeed parsedFeed;
    if ([feed isEqualToString:@"js"]) {
        parsedFeed = PcmPlayerFeed::JS;
    } else if ([feed isEqualToString:@"native"]) {
        parsedFeed = PcmPlayerFeed::NATIVE;
    } else {
        reject(@"PCM_PLAYER_INVALID_CONFIG",
               [NSString stringWithFormat:@"Invalid feed: '%@' (expected 'js' or 'native')", feed], nil);
        return;
    }

    @try {
        AVAudioSession *audioSession = [AVAudioSession sharedInstance];
        [audioSession setCategory:AVAudioSessionCategoryPlayback error:nil];
        [audioSession setActive:YES error:nil];

        auto session = std::make_shared<PcmPlayerSession>();
        session->playerId = [playerId UTF8String];
        session->sampleRate = sr;
        session->channels = ch;
        session->feed = parsedFeed;
        if (ttsInstanceId != nil && [ttsInstanceId length] > 0) {
            session->ttsInstanceId = [ttsInstanceId UTF8String];
        }
        session->audioEngine = [[AVAudioEngine alloc] init];
        session->playerNode = [[AVAudioPlayerNode alloc] init];
        session->audioFormat = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:(double)sr channels:1];

        [session->audioEngine attachNode:session->playerNode];
        [session->audioEngine connect:session->playerNode
                                   to:session->audioEngine.mainMixerNode
                               format:session->audioFormat];

        NSError *startError = nil;
        if (![session->audioEngine startAndReturnError:&startError]) {
            reject(@"PCM_PLAYER_INVALID_CONFIG",
                   [NSString stringWithFormat:@"Failed to start audio engine: %@", startError.localizedDescription], startError);
            return;
        }
        [session->playerNode play];

        {
            std::lock_guard<std::mutex> lock(g_pcm_player_mutex);
            g_pcm_players[session->playerId] = session;
        }
        resolve(nil);
    } @catch (NSException *exception) {
        reject(@"PCM_PLAYER_INVALID_CONFIG",
               [NSString stringWithFormat:@"Failed to create PCM player: %@", exception.reason], nil);
    }
}

- (void)so_writePcmChunk:(NSString *)playerId
                 samples:(NSArray<NSNumber *> *)samples
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
    if (playerId == nil || [playerId length] == 0) {
        reject(@"PCM_PLAYER_NOT_FOUND", @"playerId is required", nil);
        return;
    }
    std::string playerIdStr = [playerId UTF8String];
    auto session = pcmPlayerGet(playerIdStr);
    if (!session) {
        reject(@"PCM_PLAYER_NOT_FOUND",
               [NSString stringWithFormat:@"PCM player not found: %@", playerId], nil);
        return;
    }
    if (session->destroyed) {
        reject(@"PCM_PLAYER_DESTROYED",
               [NSString stringWithFormat:@"PCM player already destroyed: %@", playerId], nil);
        return;
    }
    if (session->feed == PcmPlayerFeed::NATIVE) {
        reject(@"PCM_PLAYER_FEED_NATIVE", @"writePcmChunk not allowed; player feed is 'native'", nil);
        return;
    }
    @try {
        NSUInteger count = [samples count];
        std::vector<float> buffer(count);
        for (NSUInteger i = 0; i < count; i++) {
            buffer[i] = [samples[i] floatValue];
        }
        session->enqueueMonoFloat32(buffer.data(), (int32_t)count);
        resolve(nil);
    } @catch (NSException *exception) {
        reject(@"PCM_PLAYER_ERROR",
               [NSString stringWithFormat:@"Failed to write PCM chunk: %@", exception.reason], nil);
    }
}

- (void)so_pausePcmPlayer:(NSString *)playerId
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
    if (playerId == nil || [playerId length] == 0) {
        reject(@"PCM_PLAYER_NOT_FOUND", @"playerId is required", nil);
        return;
    }
    auto session = pcmPlayerGet([playerId UTF8String]);
    if (!session) {
        reject(@"PCM_PLAYER_NOT_FOUND",
               [NSString stringWithFormat:@"PCM player not found: %@", playerId], nil);
        return;
    }
    @try {
        session->pause();
        resolve(nil);
    } @catch (NSException *exception) {
        reject(@"PCM_PLAYER_ERROR",
               [NSString stringWithFormat:@"Failed to pause PCM player: %@", exception.reason], nil);
    }
}

- (void)so_resumePcmPlayer:(NSString *)playerId
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
    if (playerId == nil || [playerId length] == 0) {
        reject(@"PCM_PLAYER_NOT_FOUND", @"playerId is required", nil);
        return;
    }
    auto session = pcmPlayerGet([playerId UTF8String]);
    if (!session) {
        reject(@"PCM_PLAYER_NOT_FOUND",
               [NSString stringWithFormat:@"PCM player not found: %@", playerId], nil);
        return;
    }
    @try {
        session->resume();
        resolve(nil);
    } @catch (NSException *exception) {
        reject(@"PCM_PLAYER_ERROR",
               [NSString stringWithFormat:@"Failed to resume PCM player: %@", exception.reason], nil);
    }
}

- (void)so_destroyPcmPlayer:(NSString *)playerId
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject
{
    if (playerId == nil || [playerId length] == 0) {
        resolve(nil); // idempotent
        return;
    }
    std::string playerIdStr = [playerId UTF8String];
    std::shared_ptr<PcmPlayerSession> session;
    {
        std::lock_guard<std::mutex> lock(g_pcm_player_mutex);
        auto it = g_pcm_players.find(playerIdStr);
        if (it != g_pcm_players.end()) {
            session = it->second;
            g_pcm_players.erase(it);
        }
    }
    if (session) {
        session->destroy();
    }
    resolve(nil);
}

@end
