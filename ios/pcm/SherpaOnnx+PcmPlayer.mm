/**
 * SherpaOnnx+PcmPlayer.mm — PCM player bridge methods backed by pipeline audio buffers.
 */

#import "SherpaOnnx.h"
#import <AVFoundation/AVFoundation.h>

#include "../PaLiveEntry.h"
#include "../SherpaOnnx+PipelineAudioGlobals.h"
#include "PcmPlayerRegistry.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace {

class PcmLiveDrainWorker {
 public:
    PcmLiveDrainWorker(
            std::string playerId,
            std::shared_ptr<PcmPlayerSession> session,
            std::shared_ptr<PaLiveEntry> liveEntry)
            : playerId_(std::move(playerId)),
                session_(std::move(session)),
                liveEntry_(std::move(liveEntry)) {}

    ~PcmLiveDrainWorker() {
        stop();
    }

    void start() {
        if (!liveEntry_ || !session_) return;
        running_.store(true);
        cursorId_ = liveEntry_->createCursorHandle();
        appendListenerToken_ = liveEntry_->addAppendListener([this]() { cv_.notify_one(); });
        workerThread_ = std::thread([this]() { runLoop(); });
    }

    void stop() {
        running_.store(false);
        cv_.notify_one();
        if (workerThread_.joinable()) {
            workerThread_.join();
        }
        cleanupHandles();
    }

 private:
    void runLoop() {
        constexpr int kDrainChunkSize = 4096;
        constexpr auto kWaitDuration = std::chrono::milliseconds(10);

        while (running_.load()) {
            auto chunk = liveEntry_->drainCursor(cursorId_, kDrainChunkSize);
            if (!chunk.empty()) {
                session_->enqueueMonoFloat32(chunk.data(), (int32_t)chunk.size());
                continue;
            }

            if (liveEntry_->state == PaLiveEntry::FINISHED) {
                break;
            }

            std::unique_lock<std::mutex> lock(waitMutex_);
            cv_.wait_for(lock, kWaitDuration);
        }

        running_.store(false);
    }

    void cleanupHandles() {
        if (!liveEntry_) return;
        if (appendListenerToken_ >= 0) {
            liveEntry_->removeAppendListener(appendListenerToken_);
            appendListenerToken_ = -1;
        }
        if (cursorId_ >= 0) {
            liveEntry_->releaseCursor(cursorId_);
            cursorId_ = -1;
        }
    }

    std::string playerId_;
    std::shared_ptr<PcmPlayerSession> session_;
    std::shared_ptr<PaLiveEntry> liveEntry_;
    std::atomic<bool> running_{false};
    int cursorId_ = -1;
    int appendListenerToken_ = -1;
    std::thread workerThread_;
    std::mutex waitMutex_;
    std::condition_variable cv_;
};

static std::unordered_map<std::string, std::shared_ptr<PcmLiveDrainWorker>> g_pcm_live_workers;
static std::mutex g_pcm_live_workers_mutex;

static std::shared_ptr<PcmLiveDrainWorker> pcm_take_live_worker(const std::string &playerId) {
    std::lock_guard<std::mutex> lock(g_pcm_live_workers_mutex);
    auto it = g_pcm_live_workers.find(playerId);
    if (it == g_pcm_live_workers.end()) {
        return nullptr;
    }
    auto worker = it->second;
    g_pcm_live_workers.erase(it);
    return worker;
}

}  // namespace

@implementation SherpaOnnx (PcmPlayer)

- (void)so_createPcmPlayer:(NSString *)playerId
                         audioBufferId:(NSString *)audioBufferId
                                     volume:(double)volume
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
    if (playerId == nil || [playerId length] == 0) {
        reject(@"PCM_PLAYER_INVALID_CONFIG", @"playerId is required", nil);
        return;
    }

        if (audioBufferId == nil || [audioBufferId length] == 0) {
                reject(@"AUDIO_BUFFER_NOT_FOUND", @"audioBufferId is required", nil);
        return;
    }

        const float clampedVolume = std::max(0.0f, std::min(1.0f, (float)volume));

        std::string bufferId = [audioBufferId UTF8String];
        auto liveEntry = pa_get_live_entry(bufferId);
        std::vector<float> offlineSamples;
        int sampleRate = 0;

        if (liveEntry) {
                sampleRate = liveEntry->sampleRate;
        } else {
                if (!pa_read_offline_samples(bufferId, &offlineSamples, &sampleRate)) {
                        reject(@"AUDIO_BUFFER_NOT_FOUND",
                                     [NSString stringWithFormat:@"Audio buffer not found: %@", audioBufferId],
                                     nil);
                        return;
                }
        }

        if (sampleRate <= 0) {
                reject(@"PCM_PLAYER_INVALID_CONFIG", @"sampleRate must be > 0", nil);
        return;
    }

    @try {
        AVAudioSession *audioSession = [AVAudioSession sharedInstance];
        [audioSession setCategory:AVAudioSessionCategoryPlayback error:nil];
        [audioSession setActive:YES error:nil];

        auto session = std::make_shared<PcmPlayerSession>();
        session->playerId = [playerId UTF8String];
        session->sampleRate = sampleRate;
        session->channels = 1;
        session->audioEngine = [[AVAudioEngine alloc] init];
        session->playerNode = [[AVAudioPlayerNode alloc] init];
        session->playerNode.volume = clampedVolume;
        session->audioFormat = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:(double)sampleRate channels:1];

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

        std::string playerIdStr = [playerId UTF8String];
        auto oldWorker = pcm_take_live_worker(playerIdStr);
        if (oldWorker) {
            oldWorker->stop();
        }

        std::shared_ptr<PcmPlayerSession> oldSession;
        {
            std::lock_guard<std::mutex> lock(g_pcm_player_mutex);
            auto it = g_pcm_players.find(playerIdStr);
            if (it != g_pcm_players.end()) {
                oldSession = it->second;
                g_pcm_players.erase(it);
            }
            g_pcm_players[playerIdStr] = session;
        }
        if (oldSession) {
            oldSession->destroy();
        }

        if (liveEntry) {
            auto worker = std::make_shared<PcmLiveDrainWorker>(playerIdStr, session, liveEntry);
            worker->start();
            std::lock_guard<std::mutex> lock(g_pcm_live_workers_mutex);
            g_pcm_live_workers[playerIdStr] = worker;
        } else if (!offlineSamples.empty()) {
            constexpr size_t kOfflineChunkSize = 4096;
            for (size_t i = 0; i < offlineSamples.size(); i += kOfflineChunkSize) {
                size_t count = std::min(kOfflineChunkSize, offlineSamples.size() - i);
                session->enqueueMonoFloat32(offlineSamples.data() + i, (int32_t)count);
            }
        }

        resolve(nil);
    } @catch (NSException *exception) {
        reject(@"PCM_PLAYER_INVALID_CONFIG",
               [NSString stringWithFormat:@"Failed to create PCM player: %@", exception.reason], nil);
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
    auto liveWorker = pcm_take_live_worker(playerIdStr);
    if (liveWorker) {
        liveWorker->stop();
    }

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
