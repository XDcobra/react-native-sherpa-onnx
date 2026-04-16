/**
 * SherpaOnnx+PcmPlayer.mm — PCM player bridge methods backed by pipeline audio buffers.
 *
 * Supports: create, pause, resume, seek, restart, getPosition, destroy, onEnded events.
 */

#import "../SherpaOnnx.h"
#import <AVFoundation/AVFoundation.h>
#import <React/RCTLog.h>

#include "../audio/pipeline/PaLiveEntry.h"
#include "../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "PcmPlayerRegistry.h"
#import "../audio/session/PaAudioSessionCoordinator.h"

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

constexpr int kDrainChunkSize = 4096;
constexpr auto kWaitDuration = std::chrono::milliseconds(10);

class PcmLiveDrainWorker {
 public:
    PcmLiveDrainWorker(
            std::string playerId,
            std::shared_ptr<PcmPlayerSession> session,
            std::shared_ptr<PaLiveEntry> liveEntry,
            int32_t generation,
            int64_t startAbsolutePos = -1)
            : playerId_(std::move(playerId)),
                session_(std::move(session)),
                liveEntry_(std::move(liveEntry)),
                generation_(generation),
                startAbsolutePos_(startAbsolutePos) {}

    ~PcmLiveDrainWorker() {
        stop();
    }

    void start() {
        if (!liveEntry_ || !session_) return;
        running_.store(true);
        cursorId_ = liveEntry_->createCursorHandle();
        if (startAbsolutePos_ >= 0) {
            liveEntry_->seekCursor(cursorId_, startAbsolutePos_);
        }
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
        while (running_.load() && session_->drainGeneration.load() == generation_) {
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

        // If not interrupted, mark source as exhausted
        if (session_->drainGeneration.load() == generation_ && !session_->destroyed) {
            session_->markSourceExhausted();
        }
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
    int32_t generation_;
    int64_t startAbsolutePos_;
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

/** Enqueue offline samples from startIndex to end. If not interrupted, mark source exhausted. */
static void pcm_enqueue_offline_from(
    std::shared_ptr<PcmPlayerSession> session,
    int64_t startIndex,
    int32_t generation
) {
    const auto &samples = session->offlineSamples;
    size_t start = (size_t)std::max((int64_t)0, startIndex);
    for (size_t i = start; i < samples.size(); i += kDrainChunkSize) {
        if (session->destroyed || session->drainGeneration.load() != generation) return;
        size_t count = std::min((size_t)kDrainChunkSize, samples.size() - i);
        session->enqueueMonoFloat32(samples.data() + i, (int32_t)count);
    }
    if (!session->destroyed && session->drainGeneration.load() == generation) {
        session->markSourceExhausted();
    }
}

/** Store a reference to the live entry associated with a player, for seek/restart. */
static std::unordered_map<std::string, std::shared_ptr<PaLiveEntry>> g_pcm_live_entries;
static std::mutex g_pcm_live_entries_mutex;

static NSString *const kPcmOutputSpeakerId = @"ios_builtin_speaker";
static NSString *const kPcmOutputReceiverId = @"ios_builtin_receiver";

static NSString *pa_output_kind_for_port(AVAudioSessionPort portType) {
    if ([portType isEqualToString:AVAudioSessionPortBuiltInSpeaker]) return @"built_in_speaker";
    if ([portType isEqualToString:AVAudioSessionPortBuiltInReceiver]) return @"built_in_receiver";
    if ([portType isEqualToString:AVAudioSessionPortHeadphones]) return @"wired_headphones";
    if ([portType isEqualToString:AVAudioSessionPortHeadsetMic]) return @"wired_headset";
    if ([portType isEqualToString:AVAudioSessionPortBluetoothA2DP] ||
        [portType isEqualToString:AVAudioSessionPortBluetoothHFP] ||
        [portType isEqualToString:AVAudioSessionPortBluetoothLE]) return @"bluetooth";
    if ([portType isEqualToString:AVAudioSessionPortUSBAudio]) return @"usb";
    if ([portType isEqualToString:AVAudioSessionPortHDMI]) return @"hdmi";
    if ([portType isEqualToString:AVAudioSessionPortLineOut] ||
        [portType isEqualToString:AVAudioSessionPortLineIn]) return @"line";
    if ([portType isEqualToString:AVAudioSessionPortAirPlay]) return @"airplay";
    if ([portType isEqualToString:AVAudioSessionPortCarAudio]) return @"car_audio";
    return @"unknown";
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

    NSString *intentId = [NSString stringWithFormat:@"pcm:%@", playerId];
    BOOL intentAcquired = NO;
    BOOL createSucceeded = NO;
    std::shared_ptr<PcmPlayerSession> session;
    @try {
        // Register PCM player intent with coordinator
        PaAudioSessionIntent *pcmIntent = [PaAudioSessionIntent intentWithOwnerId:intentId
                                                                        needsInput:NO
                                                                       needsOutput:YES];
        [[PaAudioSessionCoordinator shared] acquireIntent:pcmIntent];
        intentAcquired = YES;

        session = std::make_shared<PcmPlayerSession>();
        session->playerId = [playerId UTF8String];
        session->bufferId = bufferId;
        session->sampleRate = sampleRate;
        session->channels = 1;
        session->audioEngine = [[AVAudioEngine alloc] init];
        session->playerNode = [[AVAudioPlayerNode alloc] init];
        session->playerNode.volume = clampedVolume;
        session->audioFormat = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:(double)sampleRate channels:1];

        // Store offline samples for seek/restart
        session->offlineSamples = std::move(offlineSamples);

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

        // Set up onEnded callback to emit event to JS
        __weak SherpaOnnx *weakSelf = self;
        NSString *playerIdCopy = [playerId copy];
        NSString *bufferIdCopy = [audioBufferId copy];
        session->onEndedCallback = [weakSelf, playerIdCopy, bufferIdCopy]() {
            dispatch_async(dispatch_get_main_queue(), ^{
                SherpaOnnx *strongSelf = weakSelf;
                if (!strongSelf) return;
                [strongSelf sendEventWithName:@"pcmPlayerEnded"
                                         body:@{
                    @"playerId": playerIdCopy,
                    @"bufferId": bufferIdCopy,
                }];
            });
        };

        // Clean up old player with same ID
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
            // Store live entry reference for seek/restart
            {
                std::lock_guard<std::mutex> lock(g_pcm_live_entries_mutex);
                g_pcm_live_entries[playerIdStr] = liveEntry;
            }
            int32_t gen = session->drainGeneration.load();
            auto worker = std::make_shared<PcmLiveDrainWorker>(playerIdStr, session, liveEntry, gen);
            worker->start();
            std::lock_guard<std::mutex> lock(g_pcm_live_workers_mutex);
            g_pcm_live_workers[playerIdStr] = worker;
        } else if (!session->offlineSamples.empty()) {
            int32_t gen = session->drainGeneration.load();
            pcm_enqueue_offline_from(session, 0, gen);
        }

        createSucceeded = YES;
        resolve(nil);
    } @catch (NSException *exception) {
        reject(@"PCM_PLAYER_INVALID_CONFIG",
               [NSString stringWithFormat:@"Failed to create PCM player: %@", exception.reason], nil);
    } @finally {
        if (!createSucceeded) {
            if (session) {
                session->destroy();
            }
            if (intentAcquired) {
                [[PaAudioSessionCoordinator shared] releaseIntent:intentId];
            }
        }
    }
}

- (void)so_listAvailableOutputDevicesResolve:(RCTPromiseResolveBlock)resolve
                                      reject:(RCTPromiseRejectBlock)reject
{
    @try {
        AVAudioSession *session = [AVAudioSession sharedInstance];
        AVAudioSessionRouteDescription *route = session.currentRoute;

        NSMutableSet<NSString *> *selectedIds = [NSMutableSet set];
        for (AVAudioSessionPortDescription *output in route.outputs) {
            if ([output.portType isEqualToString:AVAudioSessionPortBuiltInSpeaker]) {
                [selectedIds addObject:kPcmOutputSpeakerId];
            } else if ([output.portType isEqualToString:AVAudioSessionPortBuiltInReceiver]) {
                [selectedIds addObject:kPcmOutputReceiverId];
            } else if (output.UID.length > 0) {
                [selectedIds addObject:output.UID];
            }
        }

        NSMutableDictionary<NSString *, NSMutableDictionary *> *byId = [NSMutableDictionary dictionary];

        void (^addOrMerge)(NSString *, NSString *, NSString *, BOOL, BOOL, BOOL) = ^(
            NSString *deviceId,
            NSString *name,
            NSString *kind,
            BOOL selected,
            BOOL isDefault,
            BOOL canSelect
        ) {
            if (deviceId.length == 0) return;

            NSMutableDictionary *existing = byId[deviceId];
            if (existing == nil) {
                byId[deviceId] = [@{
                    @"id": deviceId,
                    @"name": name ?: @"Output",
                    @"kind": kind ?: @"unknown",
                    @"selected": @(selected),
                    @"default": @(isDefault),
                    @"canSelect": @(canSelect),
                } mutableCopy];
                return;
            }

            if (name.length > 0) existing[@"name"] = name;
            if (kind.length > 0) existing[@"kind"] = kind;
            existing[@"selected"] = @([existing[@"selected"] boolValue] || selected);
            existing[@"default"] = @([existing[@"default"] boolValue] || isDefault);
            existing[@"canSelect"] = @([existing[@"canSelect"] boolValue] || canSelect);
        };

        addOrMerge(kPcmOutputSpeakerId, @"Built-in Speaker", @"built_in_speaker", [selectedIds containsObject:kPcmOutputSpeakerId], YES, YES);
        addOrMerge(kPcmOutputReceiverId, @"Built-in Receiver", @"built_in_receiver", [selectedIds containsObject:kPcmOutputReceiverId], NO, YES);

        NSArray<AVAudioSessionPortDescription *> *availableInputs = session.availableInputs ?: @[];
        for (AVAudioSessionPortDescription *input in availableInputs) {
            NSString *kind = pa_output_kind_for_port(input.portType);
            addOrMerge(
                input.UID ?: @"",
                input.portName ?: @"Output",
                kind,
                [selectedIds containsObject:(input.UID ?: @"")],
                NO,
                YES
            );
        }

        for (AVAudioSessionPortDescription *output in route.outputs) {
            NSString *deviceId = @"";
            if ([output.portType isEqualToString:AVAudioSessionPortBuiltInSpeaker]) {
                deviceId = kPcmOutputSpeakerId;
            } else if ([output.portType isEqualToString:AVAudioSessionPortBuiltInReceiver]) {
                deviceId = kPcmOutputReceiverId;
            } else {
                deviceId = output.UID ?: @"";
            }

            addOrMerge(
                deviceId,
                output.portName ?: @"Output",
                pa_output_kind_for_port(output.portType),
                [selectedIds containsObject:deviceId],
                [deviceId isEqualToString:kPcmOutputSpeakerId],
                [deviceId isEqualToString:kPcmOutputSpeakerId] || [deviceId isEqualToString:kPcmOutputReceiverId]
            );
        }

        NSMutableArray<NSMutableDictionary *> *result = [NSMutableArray arrayWithArray:byId.allValues];
        if (result.count > 0) {
            BOOL hasSelected = NO;
            for (NSDictionary *entry in result) {
                if ([entry[@"selected"] boolValue]) {
                    hasSelected = YES;
                    break;
                }
            }
            if (!hasSelected) {
                NSUInteger fallbackIndex = NSNotFound;
                for (NSUInteger i = 0; i < result.count; i++) {
                    if ([result[i][@"default"] boolValue]) {
                        fallbackIndex = i;
                        break;
                    }
                }
                if (fallbackIndex == NSNotFound) fallbackIndex = 0;
                result[fallbackIndex][@"selected"] = @YES;
            }
        }

        resolve(result);
    } @catch (NSException *exception) {
        reject(@"PCM_PLAYER_ERROR", exception.reason, nil);
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

- (void)so_seekPcmPlayerToMs:(NSString *)playerId
                  positionMs:(double)positionMs
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

    int64_t sampleIndex = (int64_t)((positionMs / 1000.0) * session->sampleRate);
    if (sampleIndex < 0) sampleIndex = 0;

    // Check for live entry
    std::shared_ptr<PaLiveEntry> liveEntry;
    {
        std::lock_guard<std::mutex> lock(g_pcm_live_entries_mutex);
        auto it = g_pcm_live_entries.find(playerIdStr);
        if (it != g_pcm_live_entries.end()) liveEntry = it->second;
    }

    if (liveEntry) {
        // Validate seek range for live buffers
        int64_t oldest = liveEntry->oldestAvailablePos();
        int64_t newest = liveEntry->totalSamplesWritten;
        if (sampleIndex < oldest || sampleIndex > newest) {
            reject(@"PCM_PLAYER_SEEK_OUT_OF_RANGE",
                   [NSString stringWithFormat:@"Seek position %.0f ms (sample %lld) is outside available range [%lld, %lld]",
                    positionMs, (long long)sampleIndex, (long long)oldest, (long long)newest], nil);
            return;
        }

        // Stop current drain worker
        auto oldWorker = pcm_take_live_worker(playerIdStr);
        if (oldWorker) oldWorker->stop();

        // Reset session for seek
        session->resetForSeek(sampleIndex);

        // Start new drain from seek position
        int32_t gen = session->drainGeneration.load();
        auto worker = std::make_shared<PcmLiveDrainWorker>(playerIdStr, session, liveEntry, gen, sampleIndex);
        worker->start();
        {
            std::lock_guard<std::mutex> lock(g_pcm_live_workers_mutex);
            g_pcm_live_workers[playerIdStr] = worker;
        }
    } else if (!session->offlineSamples.empty()) {
        // Clamp to end for offline
        int64_t maxSamples = (int64_t)session->offlineSamples.size();
        if (sampleIndex > maxSamples) sampleIndex = maxSamples;

        // Reset session for seek
        session->resetForSeek(sampleIndex);

        // Re-enqueue from seek position
        int32_t gen = session->drainGeneration.load();
        pcm_enqueue_offline_from(session, sampleIndex, gen);
    } else {
        reject(@"PCM_PLAYER_ERROR", @"No audio source available for seek", nil);
        return;
    }

    resolve(nil);
}

- (void)so_restartPcmPlayer:(NSString *)playerId
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject
{
    if (playerId == nil || [playerId length] == 0) {
        reject(@"PCM_PLAYER_NOT_FOUND", @"playerId is required", nil);
        return;
    }
    std::string playerIdStr = [playerId UTF8String];

    // Find the live entry to determine start position
    std::shared_ptr<PaLiveEntry> liveEntry;
    {
        std::lock_guard<std::mutex> lock(g_pcm_live_entries_mutex);
        auto it = g_pcm_live_entries.find(playerIdStr);
        if (it != g_pcm_live_entries.end()) liveEntry = it->second;
    }

    double startMs = 0.0;
    if (liveEntry) {
        int64_t oldest = liveEntry->oldestAvailablePos();
        startMs = (double)oldest / (double)liveEntry->sampleRate * 1000.0;
    }

    [self so_seekPcmPlayerToMs:playerId positionMs:startMs resolve:resolve reject:reject];
}

- (void)so_getPcmPlayerPositionMs:(NSString *)playerId
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
    resolve(@(session->getPositionMs()));
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

    // Clean up live entry reference
    {
        std::lock_guard<std::mutex> lock(g_pcm_live_entries_mutex);
        g_pcm_live_entries.erase(playerIdStr);
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

    // Release PCM player intent from coordinator
    NSString *intentId = [NSString stringWithFormat:@"pcm:%@", playerId];
    [[PaAudioSessionCoordinator shared] releaseIntent:intentId];

    resolve(nil);
}

@end
