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
    [playerNode scheduleBuffer:buffer completionHandler:nil];
}

void PcmPlayerSession::pause() {
    if (destroyed || playerNode == nil) return;
    [playerNode pause];
}

void PcmPlayerSession::resume() {
    if (destroyed || playerNode == nil) return;
    [playerNode play];
}

void PcmPlayerSession::destroy() {
    if (destroyed) return;
    destroyed = true;
    if (playerNode != nil) [playerNode stop];
    if (audioEngine != nil) {
        [audioEngine stop];
        [audioEngine reset];
    }
    playerNode = nil;
    audioEngine = nil;
    audioFormat = nil;
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
