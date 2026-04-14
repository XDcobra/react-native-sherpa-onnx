/**
 * PcmPlayerRegistry.h — Standalone PCM player registry (decoupled from TtsInstanceState).
 */

#pragma once

#import <AVFoundation/AVFoundation.h>

#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

struct PcmPlayerSession {
    std::string playerId;
    std::string bufferId;
    int32_t sampleRate = 0;
    int32_t channels = 1;
    __strong AVAudioEngine *audioEngine = nil;
    __strong AVAudioPlayerNode *playerNode = nil;
    __strong AVAudioFormat *audioFormat = nil;
    bool destroyed = false;

    // ---- onEnded support ----
    std::function<void()> onEndedCallback;
    std::atomic<int32_t> buffersInFlight{0};
    std::atomic<bool> sourceExhausted{false};
    std::atomic<bool> endedEmitted{false};
    std::atomic<int32_t> drainGeneration{0};

    // ---- Position tracking ----
    std::atomic<int64_t> seekPositionSamples{0};

    // ---- Offline sample storage for seek ----
    std::vector<float> offlineSamples;

    void enqueueMonoFloat32(const float *samples, int32_t numSamples);
    void markSourceExhausted();
    void pause();
    void resume();
    void destroy();
    double getPositionMs();

    /**
     * Reset playback state for seek. Stops playerNode, clears scheduled buffers,
     * resets counters. Caller must re-enqueue data after this.
     */
    void resetForSeek(int64_t newSeekPositionSamples);
};

// Global player registry (thread-safe via g_pcm_player_mutex).
extern std::unordered_map<std::string, std::shared_ptr<PcmPlayerSession>> g_pcm_players;
extern std::mutex g_pcm_player_mutex;

// Lookup helper (returns nullptr if not found or destroyed).
std::shared_ptr<PcmPlayerSession> pcmPlayerGet(const std::string &playerId);

// Destroy and remove all players (for module teardown).
void pcmPlayerDestroyAll();
