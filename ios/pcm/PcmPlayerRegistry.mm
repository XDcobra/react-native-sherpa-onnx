/**
 * PcmPlayerRegistry.mm — Implementation of standalone PCM player registry.
 */

#import <AVFoundation/AVFoundation.h>

#include "PcmPlayerRegistry.h"

#include <mutex>
#include <string>

std::unordered_map<std::string, std::shared_ptr<PcmPlayerSession>> g_pcm_players;
std::mutex g_pcm_player_mutex;

void PcmPlayerSession::enqueueMonoFloat32(const float *samples, int32_t numSamples) {
    if (destroyed || playerNode == nil || audioFormat == nil || numSamples <= 0) return;
    AVAudioPCMBuffer *buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:audioFormat
                                                             frameCapacity:(AVAudioFrameCount)numSamples];
    buffer.frameLength = (AVAudioFrameCount)numSamples;
    memcpy(buffer.floatChannelData[0], samples, numSamples * sizeof(float));

    int32_t gen = drainGeneration.load();
    buffersInFlight.fetch_add(1);

    [playerNode scheduleBuffer:buffer completionCallbackType:AVAudioPlayerNodeCompletionDataConsumed completionHandler:^(AVAudioPlayerNodeCompletionCallbackType callbackType) {
        int32_t remaining = buffersInFlight.fetch_sub(1) - 1;
        if (remaining == 0 && sourceExhausted.load() && gen == drainGeneration.load()) {
            if (!endedEmitted.exchange(true)) {
                if (onEndedCallback) onEndedCallback();
            }
        }
    }];
}

void PcmPlayerSession::markSourceExhausted() {
    sourceExhausted.store(true);
    // Check if all buffers already consumed
    if (buffersInFlight.load() == 0 && !endedEmitted.exchange(true)) {
        if (onEndedCallback) onEndedCallback();
    }
}

void PcmPlayerSession::pause() {
    if (destroyed || playerNode == nil) return;
    [playerNode pause];
}

void PcmPlayerSession::resume() {
    if (destroyed || playerNode == nil) return;
    [playerNode play];
}

void PcmPlayerSession::resetForSeek(int64_t newSeekPositionSamples) {
    // Increment generation to invalidate in-flight completion handlers
    drainGeneration.fetch_add(1);

    // Stop and restart the player node to clear all scheduled buffers
    if (playerNode != nil) {
        [playerNode stop];
    }

    // Reset counters
    buffersInFlight.store(0);
    sourceExhausted.store(false);
    endedEmitted.store(false);
    seekPositionSamples.store(newSeekPositionSamples);

    // Restart the player node
    if (playerNode != nil) {
        [playerNode play];
    }
}

double PcmPlayerSession::getPositionMs() {
    if (destroyed || playerNode == nil || sampleRate <= 0) return 0.0;

    AVAudioTime *nodeTime = [playerNode lastRenderTime];
    if (nodeTime == nil || !nodeTime.isSampleTimeValid) {
        return (double)seekPositionSamples.load() / (double)sampleRate * 1000.0;
    }
    AVAudioTime *playerTime = [playerNode playerTimeForNodeTime:nodeTime];
    if (playerTime == nil || !playerTime.isSampleTimeValid) {
        return (double)seekPositionSamples.load() / (double)sampleRate * 1000.0;
    }
    int64_t samplePos = (int64_t)playerTime.sampleTime;
    if (samplePos < 0) samplePos = 0;
    return ((double)seekPositionSamples.load() + (double)samplePos) / (double)sampleRate * 1000.0;
}

void PcmPlayerSession::destroy() {
    if (destroyed) return;
    destroyed = true;
    drainGeneration.fetch_add(1);
    if (playerNode != nil) [playerNode stop];
    if (audioEngine != nil) {
        [audioEngine stop];
        [audioEngine reset];
    }
    playerNode = nil;
    audioEngine = nil;
    audioFormat = nil;
    onEndedCallback = nullptr;
}

std::shared_ptr<PcmPlayerSession> pcmPlayerGet(const std::string &playerId) {
    std::lock_guard<std::mutex> lock(g_pcm_player_mutex);
    auto it = g_pcm_players.find(playerId);
    if (it == g_pcm_players.end() || it->second->destroyed) return nullptr;
    return it->second;
}

void pcmPlayerDestroyAll() {
    std::lock_guard<std::mutex> lock(g_pcm_player_mutex);
    for (auto &pair : g_pcm_players) {
        pair.second->destroy();
    }
    g_pcm_players.clear();
}
