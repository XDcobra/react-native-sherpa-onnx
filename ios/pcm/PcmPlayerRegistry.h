/**
 * PcmPlayerRegistry.h — Standalone PCM player registry (decoupled from TtsInstanceState).
 */

#pragma once

#import <AVFoundation/AVFoundation.h>

#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

enum class PcmPlayerFeed { JS, NATIVE };

struct PcmPlayerSession {
    std::string playerId;
    int32_t sampleRate = 0;
    int32_t channels = 1;
    PcmPlayerFeed feed = PcmPlayerFeed::JS;
    std::string ttsInstanceId;  // empty = standalone
    __strong AVAudioEngine *audioEngine = nil;
    __strong AVAudioPlayerNode *playerNode = nil;
    __strong AVAudioFormat *audioFormat = nil;
    bool destroyed = false;

    void enqueueMonoFloat32(const float *samples, int32_t numSamples);
    void pause();
    void resume();
    void destroy();
};

// Global player registry (thread-safe via g_pcm_player_mutex).
extern std::unordered_map<std::string, std::shared_ptr<PcmPlayerSession>> g_pcm_players;
extern std::mutex g_pcm_player_mutex;

// Lookup helper (returns nullptr if not found or destroyed).
std::shared_ptr<PcmPlayerSession> pcmPlayerGet(const std::string &playerId);

// Find player bound to a TTS instance.
std::shared_ptr<PcmPlayerSession> pcmPlayerFindByTtsInstanceId(const std::string &ttsInstanceId);

// Destroy and remove all players (for module teardown).
void pcmPlayerDestroyAll();
