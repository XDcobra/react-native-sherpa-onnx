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
constexpr int kDefaultMaxBufferedMs = 300;
constexpr auto kWaitDuration = std::chrono::milliseconds(10);

static int32_t pcm_compute_max_buffered_frames(int sampleRate) {
    return std::max((sampleRate * kDefaultMaxBufferedMs) / 1000, kDrainChunkSize * 2);
}

static int32_t pcm_compute_resume_buffered_frames(int32_t maxBufferedFrames) {
    return std::max(maxBufferedFrames / 2, kDrainChunkSize);
}

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
        bool reachedSourceEnd = false;
        while (running_.load() && session_->drainGeneration.load() == generation_) {
            auto chunk = liveEntry_->drainCursor(cursorId_, kDrainChunkSize);
            if (!chunk.empty()) {
                if (!session_->enqueueMonoFloat32(chunk.data(), (int32_t)chunk.size(), generation_)) {
                    break;
                }
                continue;
            }

            if (liveEntry_->state == PaLiveEntry::FINISHED) {
                reachedSourceEnd = true;
                break;
            }

            std::unique_lock<std::mutex> lock(waitMutex_);
            cv_.wait_for(lock, kWaitDuration);
        }

        running_.store(false);

        // If not interrupted, mark source as exhausted
        if (reachedSourceEnd && session_->drainGeneration.load() == generation_ && !session_->destroyed) {
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

class PcmOfflineDrainWorker {
 public:
    PcmOfflineDrainWorker(
            std::string playerId,
            std::shared_ptr<PcmPlayerSession> session,
            std::string bufferId,
            int32_t generation,
            int64_t startSampleIndex = 0)
            : playerId_(std::move(playerId)),
                session_(std::move(session)),
                bufferId_(std::move(bufferId)),
                generation_(generation),
                startSampleIndex_(startSampleIndex) {}

    ~PcmOfflineDrainWorker() {
        stop();
    }

    void start() {
        if (!session_) return;
        running_.store(true);
        workerThread_ = std::thread([this]() { runLoop(); });
    }

    void stop() {
        running_.store(false);
        if (workerThread_.joinable()) {
            workerThread_.join();
        }
    }

 private:
    void runLoop() {
        int64_t cursor = std::max<int64_t>(0, startSampleIndex_);
        int64_t chunksRead = 0;
        bool reachedSourceEnd = false;

        
        while (running_.load() && session_->drainGeneration.load() == generation_ && !session_->destroyed) {
            std::vector<float> chunk;
            std::string errorCode;
            std::string errorMessage;
            bool ok = pa_get_offline_samples_slice(
                bufferId_,
                (int)cursor,
                kDrainChunkSize,
                &chunk,
                &errorCode,
                &errorMessage
            );

            if (!ok) {
                break;
            }

            if (chunk.empty()) {
                reachedSourceEnd = true;
                break;
            }

            if (!session_->enqueueMonoFloat32(chunk.data(), (int32_t)chunk.size(), generation_)) {
                break;
            }

            cursor += (int64_t)chunk.size();
            chunksRead++;
            if (chunksRead % 128 == 0) {
                int64_t bufferedFrames = 0;
                {
                    std::lock_guard<std::mutex> lock(session_->enqueueMutex);
                    bufferedFrames = session_->bufferedFrames;
                }
                int bufferedMs = session_->sampleRate > 0
                    ? (int)((bufferedFrames * 1000LL) / (int64_t)session_->sampleRate)
                    : 0;
                            }
        }

        running_.store(false);
        if (reachedSourceEnd && session_->drainGeneration.load() == generation_ && !session_->destroyed) {
            session_->markSourceExhausted();
        }

        int64_t bufferedFramesEnd = 0;
        {
            std::lock_guard<std::mutex> lock(session_->enqueueMutex);
            bufferedFramesEnd = session_->bufferedFrames;
        }
            }

    std::string playerId_;
    std::shared_ptr<PcmPlayerSession> session_;
    std::string bufferId_;
    int32_t generation_;
    int64_t startSampleIndex_;
    std::atomic<bool> running_{false};
    std::thread workerThread_;
};

static std::unordered_map<std::string, std::shared_ptr<PcmLiveDrainWorker>> g_pcm_live_workers;
static std::mutex g_pcm_live_workers_mutex;
static std::unordered_map<std::string, std::shared_ptr<PcmOfflineDrainWorker>> g_pcm_offline_workers;
static std::mutex g_pcm_offline_workers_mutex;

/** Store a reference to the live entry associated with a player, for seek/restart. */
static std::unordered_map<std::string, std::shared_ptr<PaLiveEntry>> g_pcm_live_entries;
static std::mutex g_pcm_live_entries_mutex;

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

static std::shared_ptr<PcmOfflineDrainWorker> pcm_take_offline_worker(const std::string &playerId) {
    std::lock_guard<std::mutex> lock(g_pcm_offline_workers_mutex);
    auto it = g_pcm_offline_workers.find(playerId);
    if (it == g_pcm_offline_workers.end()) {
        return nullptr;
    }
    auto worker = it->second;
    g_pcm_offline_workers.erase(it);
    return worker;
}

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

void pcmPlayerStopAllDrainWorkers() {
    std::vector<std::shared_ptr<PcmLiveDrainWorker>> liveWorkers;
    {
        std::lock_guard<std::mutex> lock(g_pcm_live_workers_mutex);
        for (auto &pair : g_pcm_live_workers) {
            liveWorkers.push_back(pair.second);
        }
        g_pcm_live_workers.clear();
    }
    for (const auto &worker : liveWorkers) {
        if (worker) worker->stop();
    }

    std::vector<std::shared_ptr<PcmOfflineDrainWorker>> offlineWorkers;
    {
        std::lock_guard<std::mutex> lock(g_pcm_offline_workers_mutex);
        for (auto &pair : g_pcm_offline_workers) {
            offlineWorkers.push_back(pair.second);
        }
        g_pcm_offline_workers.clear();
    }
    for (const auto &worker : offlineWorkers) {
        if (worker) worker->stop();
    }

    {
        std::lock_guard<std::mutex> lock(g_pcm_live_entries_mutex);
        g_pcm_live_entries.clear();
    }
}

@implementation SherpaOnnx (PcmPlayer)

static NSString *const kOfflineOomCode = @"OFFLINE_OOM";
static NSString *const kOfflinePlaybackOomMessage =
    @"Not enough memory for offline playback buffering. Please use a streaming playback path for large audio inputs.";

static BOOL so_reject_if_terminal_oom(const std::shared_ptr<PcmPlayerSession> &session, RCTPromiseRejectBlock reject) {
    if (!session || !session->terminalOom.load()) {
        return NO;
    }
    reject(kOfflineOomCode, kOfflinePlaybackOomMessage, nil);
    return YES;
}

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
    int sampleRate = 0;
    int offlineNumSamples = 0;
    bool hasOfflineSource = false;

    if (liveEntry) {
        sampleRate = liveEntry->sampleRate;
    } else {
        if (pa_is_live_invalidated(bufferId)) {
            reject(
                @"BUFFER_INVALIDATED",
                [NSString stringWithFormat:@"Audio buffer is invalidated after transfer: %@", audioBufferId],
                nil
            );
            return;
        }
        hasOfflineSource = true;
        std::string errorCode;
        std::string errorMessage;
        bool ok = pa_get_offline_metadata(
            bufferId,
            &sampleRate,
            &offlineNumSamples,
            &errorCode,
            &errorMessage
        );
        if (!ok) {
            reject(
                @"AUDIO_BUFFER_NOT_FOUND",
                [NSString stringWithFormat:@"Audio buffer not found: %@", audioBufferId],
                nil
            );
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
        session->hasOfflineSource = hasOfflineSource;
        session->offlineTotalSamples = hasOfflineSource ? (int64_t)offlineNumSamples : 0;
        session->maxBufferedFrames = pcm_compute_max_buffered_frames(sampleRate);
        session->resumeBufferedFrames = pcm_compute_resume_buffered_frames(session->maxBufferedFrames);

        
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
        auto oldLiveWorker = pcm_take_live_worker(playerIdStr);
        if (oldLiveWorker) {
            oldLiveWorker->stop();
        }
        auto oldOfflineWorker = pcm_take_offline_worker(playerIdStr);
        if (oldOfflineWorker) {
            oldOfflineWorker->stop();
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
                g_pcm_live_entries.erase(playerIdStr);
                g_pcm_live_entries[playerIdStr] = liveEntry;
            }
            int32_t gen = session->drainGeneration.load();
            auto worker = std::make_shared<PcmLiveDrainWorker>(playerIdStr, session, liveEntry, gen);
            worker->start();
            std::lock_guard<std::mutex> lock(g_pcm_live_workers_mutex);
            g_pcm_live_workers[playerIdStr] = worker;
        } else if (session->hasOfflineSource) {
            {
                std::lock_guard<std::mutex> lock(g_pcm_live_entries_mutex);
                g_pcm_live_entries.erase(playerIdStr);
            }
            int32_t gen = session->drainGeneration.load();
            auto worker = std::make_shared<PcmOfflineDrainWorker>(playerIdStr, session, bufferId, gen, 0);
            worker->start();
            std::lock_guard<std::mutex> lock(g_pcm_offline_workers_mutex);
            g_pcm_offline_workers[playerIdStr] = worker;
        }

        if (session->terminalOom.load()) {
            reject(kOfflineOomCode, kOfflinePlaybackOomMessage, nil);
            return;
        }

        createSucceeded = YES;
        resolve(nil);
    } @catch (NSException *exception) {
        NSString *reason = exception.reason ?: @"";
        NSString *reasonLower = [reason lowercaseString];
        if ([reasonLower containsString:@"memory"] || [reasonLower containsString:@"alloc"]) {
            reject(kOfflineOomCode, kOfflinePlaybackOomMessage, nil);
            return;
        }
        reject(@"PCM_PLAYER_INVALID_CONFIG",
               [NSString stringWithFormat:@"Failed to create PCM player: %@", exception.reason], nil);
    } @finally {
        if (!createSucceeded) {
            std::string playerIdStr = [playerId UTF8String];

            {
                std::lock_guard<std::mutex> lock(g_pcm_player_mutex);
                auto it = g_pcm_players.find(playerIdStr);
                if (it != g_pcm_players.end() && it->second == session) {
                    g_pcm_players.erase(it);
                }
            }
            {
                std::lock_guard<std::mutex> lock(g_pcm_live_entries_mutex);
                g_pcm_live_entries.erase(playerIdStr);
            }

            auto liveWorker = pcm_take_live_worker(playerIdStr);
            if (liveWorker) {
                liveWorker->stop();
            }
            auto offlineWorker = pcm_take_offline_worker(playerIdStr);
            if (offlineWorker) {
                offlineWorker->stop();
            }
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
    if (so_reject_if_terminal_oom(session, reject)) {
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
    if (so_reject_if_terminal_oom(session, reject)) {
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
    if (so_reject_if_terminal_oom(session, reject)) {
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

        // Stop any current drain workers for this player.
        auto oldLiveWorker = pcm_take_live_worker(playerIdStr);
        if (oldLiveWorker) oldLiveWorker->stop();
        auto oldOfflineWorker = pcm_take_offline_worker(playerIdStr);
        if (oldOfflineWorker) oldOfflineWorker->stop();

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
    } else if (session->hasOfflineSource) {
        // Stop any current drain workers for this player.
        auto oldLiveWorker = pcm_take_live_worker(playerIdStr);
        if (oldLiveWorker) oldLiveWorker->stop();
        auto oldOfflineWorker = pcm_take_offline_worker(playerIdStr);
        if (oldOfflineWorker) oldOfflineWorker->stop();

        // Clamp to end for offline
        int64_t maxSamples = session->offlineTotalSamples;
        if (sampleIndex > maxSamples) sampleIndex = maxSamples;

        // Reset session for seek
        session->resetForSeek(sampleIndex);

        // Restart bounded offline drain from seek position.
        int32_t gen = session->drainGeneration.load();
        auto worker = std::make_shared<PcmOfflineDrainWorker>(
            playerIdStr,
            session,
            session->bufferId,
            gen,
            sampleIndex
        );
        worker->start();
        {
            std::lock_guard<std::mutex> lock(g_pcm_offline_workers_mutex);
            g_pcm_offline_workers[playerIdStr] = worker;
        }
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
    if (so_reject_if_terminal_oom(session, reject)) {
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
    auto offlineWorker = pcm_take_offline_worker(playerIdStr);
    if (offlineWorker) {
        offlineWorker->stop();
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
