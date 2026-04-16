/**
 * PcmPlayerRegistry.mm — Implementation of standalone PCM player registry.
 */

#import <AVFoundation/AVFoundation.h>
#import <React/RCTLog.h>

#include "PcmPlayerRegistry.h"

#include <algorithm>
#include <chrono>
#include <mutex>
#include <string>

// Implemented in SherpaOnnx+PcmPlayer.mm
extern void pcmPlayerStopAllDrainWorkers(void);

std::unordered_map<std::string, std::shared_ptr<PcmPlayerSession>> g_pcm_players;
std::mutex g_pcm_player_mutex;

bool PcmPlayerSession::enqueueMonoFloat32(const float *samples, int32_t numSamples, int32_t expectedGeneration) {
    if (destroyed || playerNode == nil || audioFormat == nil || numSamples <= 0 || terminalOom.load()) return false;

    {
        std::unique_lock<std::mutex> lock(enqueueMutex);
          while (!destroyed &&
              !terminalOom.load() &&
                (expectedGeneration < 0 || drainGeneration.load() == expectedGeneration) &&
                maxBufferedFrames > 0 &&
                (bufferedFrames + numSamples) > maxBufferedFrames) {
            if (!highWaterActive) {
                highWaterActive = true;
            }
            enqueueCv.wait_for(lock, std::chrono::milliseconds(10));
        }

        if (destroyed || terminalOom.load() || (expectedGeneration >= 0 && drainGeneration.load() != expectedGeneration)) {
            return false;
        }
        bufferedFrames += numSamples;
    }

    AVAudioPCMBuffer *buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:audioFormat
                                                             frameCapacity:(AVAudioFrameCount)numSamples];
    if (buffer == nil) {
        terminalOom.store(true);
        RCTLogError(@"OFFLINE_OOM enqueueMonoFloat32 buffer allocation failed for playerId=%s bufferId=%s", playerId.c_str(), bufferId.c_str());
        std::lock_guard<std::mutex> lock(enqueueMutex);
        bufferedFrames = std::max<int64_t>(0, bufferedFrames - numSamples);
        enqueueCv.notify_all();
        return false;
    }
    buffer.frameLength = (AVAudioFrameCount)numSamples;
    memcpy(buffer.floatChannelData[0], samples, numSamples * sizeof(float));

    int32_t gen = drainGeneration.load();
    int32_t chunkFrames = numSamples;
    buffersInFlight.fetch_add(1);

    [playerNode scheduleBuffer:buffer completionCallbackType:AVAudioPlayerNodeCompletionDataConsumed completionHandler:^(__unused AVAudioPlayerNodeCompletionCallbackType callbackType) {
        int32_t remaining = buffersInFlight.fetch_sub(1) - 1;
        {
            std::lock_guard<std::mutex> lock(enqueueMutex);
            bufferedFrames = std::max<int64_t>(0, bufferedFrames - chunkFrames);
            if (highWaterActive && bufferedFrames <= resumeBufferedFrames) {
                highWaterActive = false;
            }
        }
        enqueueCv.notify_all();
        if (remaining == 0 && sourceExhausted.load() && gen == drainGeneration.load()) {
            if (!endedEmitted.exchange(true)) {
                if (onEndedCallback) onEndedCallback();
            }
        }
    }];

    return true;
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
    {
        std::lock_guard<std::mutex> lock(enqueueMutex);
        bufferedFrames = 0;
        highWaterActive = false;
    }
    enqueueCv.notify_all();

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
    {
        std::lock_guard<std::mutex> lock(enqueueMutex);
        bufferedFrames = 0;
        highWaterActive = false;
    }
    enqueueCv.notify_all();
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
    pcmPlayerStopAllDrainWorkers();
    std::lock_guard<std::mutex> lock(g_pcm_player_mutex);
    for (auto &pair : g_pcm_players) {
        pair.second->destroy();
    }
    g_pcm_players.clear();
}
