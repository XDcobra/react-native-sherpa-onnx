#import "../../SherpaOnnx.h"
#include "engine/TtsEngineStore.h"
#include "pipeline/TtsOfflineLivePipelineWorker.h"
#include "options/TtsGenerationOptionsHelpers.h"
#include "../../pipeline/bridge/SherpaOnnx+StreamingPipelineCompletion.h"
#include "../../pipeline/core/SherpaOnnx+StreamingPipeline.h"
#include "../../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "../../textbuffer/core/SherpaOnnx+TextBufferGlobals.h"
#include "../../segmentbuffer/core/SherpaOnnx+SegmentBufferGlobals.h"
#include "../../audio/pipeline/PaLiveEntry.h"

// Instance → active pipeline tracking
static std::unordered_map<std::string, std::string> g_tts_instance_to_pipeline;
static std::mutex g_tts_pipeline_mutex;

@interface SherpaOnnx (TTSOnlineInternal)
- (void)so_createPcmPlayer:(NSString *)playerId
          audioBufferId:(NSString *)audioBufferId
              volume:(double)volume
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject;
- (void)so_pausePcmPlayer:(NSString *)playerId
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject;
- (void)so_resumePcmPlayer:(NSString *)playerId
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject;
- (void)so_seekPcmPlayerToMs:(NSString *)playerId
                  positionMs:(double)positionMs
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject;
- (void)so_restartPcmPlayer:(NSString *)playerId
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject;
- (void)so_getPcmPlayerPositionMs:(NSString *)playerId
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject;
- (void)so_destroyPcmPlayer:(NSString *)playerId
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject;
- (void)so_listAvailableOutputDevicesResolve:(RCTPromiseResolveBlock)resolve
                                       reject:(RCTPromiseRejectBlock)reject;
@end

@implementation SherpaOnnx (TTSOnline)

- (void)startTtsOfflineLivePipeline:(NSString *)instanceId
                textInLiveBufferId:(NSString *)textInLiveBufferId
               audioOutLiveBufferId:(NSString *)audioOutLiveBufferId
                            options:(JS::NativeSherpaOnnx::SpecStartTtsOfflineLivePipelineOptions &)options
                            resolve:(RCTPromiseResolveBlock)resolve
                             reject:(RCTPromiseRejectBlock)reject
{
    if (!instanceId || [instanceId length] == 0) {
        reject(@"TTS_PIPELINE_INSTANCE_NOT_FOUND", @"TTS engine instance not found", nil);
        return;
    }
    if (!textInLiveBufferId || [textInLiveBufferId length] == 0) {
        reject(@"TTS_PIPELINE_TEXT_BUFFER_NOT_FOUND", @"Input live text buffer id is required", nil);
        return;
    }
    if (!audioOutLiveBufferId || [audioOutLiveBufferId length] == 0) {
        reject(@"TTS_PIPELINE_AUDIO_BUFFER_NOT_FOUND", @"Output live audio buffer id is required", nil);
        return;
    }

    NSString *attachedSegmentationEngineId = options.attachedSegmentationEngineId();
    if (attachedSegmentationEngineId == nil || [attachedSegmentationEngineId length] == 0) {
        reject(@"TTS_INVALID_ARGUMENT", @"options.attachedSegmentationEngineId is required", nil);
        return;
    }
    NSString *segmentLiveBufferId = options.segmentLiveBufferId();

    std::string instanceKey = [instanceId UTF8String];
    std::string textBufferKey = [textInLiveBufferId UTF8String];
    std::string audioBufferKey = [audioOutLiveBufferId UTF8String];
    std::string attachedEngineKey = [attachedSegmentationEngineId UTF8String];
    std::string segmentBufferKey =
      segmentLiveBufferId ? std::string([segmentLiveBufferId UTF8String]) : "";

    std::shared_ptr<TtsInstanceState> inst;
    {
        std::lock_guard<std::mutex> lock(g_tts_mutex);
        auto it = g_tts_instances.find(instanceKey);
        if (it == g_tts_instances.end() || !it->second || !it->second->wrapper || !it->second->wrapper->isInitialized()) {
            reject(@"TTS_PIPELINE_INSTANCE_NOT_FOUND",
                   [NSString stringWithFormat:@"TTS engine instance not found: %@", instanceId], nil);
            return;
        }
        inst = it->second;
    }

    auto textInputEntry = txt_get_live_entry(textBufferKey);
    if (!textInputEntry) {
        reject(@"TTS_PIPELINE_TEXT_BUFFER_NOT_FOUND",
               [NSString stringWithFormat:@"Input live text buffer not found: %@", textInLiveBufferId], nil);
        return;
    }
    if (!txt_live_is_recording(textInputEntry)) {
        reject(@"TTS_PIPELINE_BUFFER_NOT_RECORDING", @"Input text buffer is not in recording state", nil);
        return;
    }

    std::shared_ptr<PaLiveEntry> outputEntry;
    {
        std::lock_guard<std::mutex> lock(g_pa_mutex);
        auto it = g_pa_live.find(audioBufferKey);
        if (it == g_pa_live.end() || !it->second) {
            reject(@"TTS_PIPELINE_AUDIO_BUFFER_NOT_FOUND",
                   [NSString stringWithFormat:@"Output live audio buffer not found: %@", audioOutLiveBufferId], nil);
            return;
        }
        outputEntry = it->second;
    }
    if (outputEntry->state != PaLiveEntry::RECORDING) {
        reject(@"TTS_PIPELINE_BUFFER_NOT_RECORDING", @"Output audio buffer is not in recording state", nil);
        return;
    }

    if (!segmentBufferKey.empty()) {
        auto segmentInputEntry = seg_get_live_entry(segmentBufferKey);
        if (!segmentInputEntry) {
            reject(@"SEGMENT_BUFFER_NOT_FOUND",
                   [NSString stringWithFormat:@"Input live segment buffer not found: %@", segmentLiveBufferId ?: @""],
                   nil);
            return;
        }
        (void)segmentInputEntry;
    }

    int ttsSampleRate = inst->wrapper->getSampleRate();
    if (outputEntry->sampleRate != ttsSampleRate) {
        reject(@"TTS_PIPELINE_SAMPLE_RATE_MISMATCH",
               [NSString stringWithFormat:@"Output buffer sample rate (%d) does not match TTS model sample rate (%d)",
                outputEntry->sampleRate, ttsSampleRate], nil);
        return;
    }

    {
        std::lock_guard<std::mutex> tpLock(g_tts_pipeline_mutex);
        auto pit = g_tts_instance_to_pipeline.find(instanceKey);
        if (pit != g_tts_instance_to_pipeline.end()) {
            std::string existingPipelineId = pit->second;
            std::shared_ptr<StreamingPipelineWorker> staleWorker;
            {
                std::lock_guard<std::mutex> lock(g_streaming_pipeline_mutex);
                auto it = g_streaming_pipelines.find(existingPipelineId);
                if (it != g_streaming_pipelines.end()) {
                    if (it->second && it->second->isRunning()) {
                        reject(@"TTS_PIPELINE_ALREADY_RUNNING",
                               [NSString stringWithFormat:@"TTS pipeline already running for instance %@", instanceId],
                               nil);
                        return;
                    }
                    staleWorker = it->second;
                    g_streaming_pipelines.erase(it);
                }
            }
            if (staleWorker) {
                staleWorker->release();
            }
            g_tts_instance_to_pipeline.erase(pit);
        }
    }

    int32_t defaultSid = 0;
    float defaultSpeed = 1.0f;
    if (auto sidOpt = options.sid()) defaultSid = static_cast<int32_t>(sidOpt.value());
    if (auto speedOpt = options.speed()) defaultSpeed = static_cast<float>(speedOpt.value());

    std::optional<std::string> defaultLang;

    std::optional<sherpaonnx::VoiceCloneOptions> voiceClone;
    NSString *refBufferId = options.referenceAudioBufferId();
    if (refBufferId != nil && [refBufferId length] > 0) {
        auto modelKind = inst->wrapper->getModelKind();
        if (modelKind != sherpaonnx::TtsModelKind::kPocket) {
            reject(@"TTS_PIPELINE_VOICE_CLONE_UNSUPPORTED",
                   @"Voice cloning in pipeline mode is only supported for Pocket TTS", nil);
            return;
        }
        std::vector<float> refSamples;
        int refSampleRate = 0;
        if (!pa_read_offline_samples(std::string([refBufferId UTF8String]), &refSamples, &refSampleRate)) {
            reject(@"TTS_PIPELINE_VOICE_CLONE_REF_NOT_FOUND",
                   [NSString stringWithFormat:@"Reference audio buffer not found: %@", refBufferId], nil);
            return;
        }

        sherpaonnx::VoiceCloneOptions clone;
        clone.reference_audio = std::move(refSamples);
        clone.reference_sample_rate = static_cast<int32_t>(refSampleRate);
        NSString *refText = options.referenceText();
        clone.reference_text = refText != nil ? std::string([refText UTF8String] ?: "") : "";
        clone.silence_scale = 0.2f;
        clone.num_steps = kDefaultVoiceCloneNumSteps;
        voiceClone = std::move(clone);
    }

    try {
        std::string pipelineId = std::string("tts_offline_live_") +
          std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
        auto worker = std::make_shared<TtsOfflineLivePipelineWorker>(
          pipelineId,
          attachedEngineKey,
          textInputEntry,
          outputEntry,
          inst->wrapper.get(),
          defaultSid,
          defaultSpeed,
          std::move(voiceClone),
          std::move(defaultLang)
        );

        {
            std::lock_guard<std::mutex> lock(g_streaming_pipeline_mutex);
            g_streaming_pipelines[pipelineId] = worker;
        }
        worker->start();
        so_start_streaming_pipeline_completion_watcher(self, pipelineId, worker);

        {
            std::lock_guard<std::mutex> tpLock(g_tts_pipeline_mutex);
            g_tts_instance_to_pipeline[instanceKey] = pipelineId;
        }
        resolve(@{ @"pipelineId": [NSString stringWithUTF8String:pipelineId.c_str()] ?: @"" });
    } catch (const std::exception &e) {
        reject(@"TTS_OFFLINE_LIVE_PIPELINE_ERROR", [NSString stringWithUTF8String:e.what()], nil);
    } catch (...) {
        reject(@"TTS_OFFLINE_LIVE_PIPELINE_ERROR", @"Failed to start offline live TTS pipeline", nil);
    }
}

- (void)createPcmPlayer:(NSString *)playerId
         audioBufferId:(NSString *)audioBufferId
              volume:(double)volume
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject {
  [self so_createPcmPlayer:playerId
          audioBufferId:audioBufferId
              volume:volume
                    resolve:resolve
                     reject:reject];
}

- (void)listAvailableOutputDevices:(RCTPromiseResolveBlock)resolve
                             reject:(RCTPromiseRejectBlock)reject {
  [self so_listAvailableOutputDevicesResolve:resolve reject:reject];
}

- (void)pausePcmPlayer:(NSString *)playerId
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject {
  [self so_pausePcmPlayer:playerId resolve:resolve reject:reject];
}

- (void)resumePcmPlayer:(NSString *)playerId
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject {
  [self so_resumePcmPlayer:playerId resolve:resolve reject:reject];
}

- (void)seekPcmPlayerToMs:(NSString *)playerId
               positionMs:(double)positionMs
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject {
  [self so_seekPcmPlayerToMs:playerId positionMs:positionMs resolve:resolve reject:reject];
}

- (void)restartPcmPlayer:(NSString *)playerId
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  [self so_restartPcmPlayer:playerId resolve:resolve reject:reject];
}

- (void)getPcmPlayerPositionMs:(NSString *)playerId
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject {
  [self so_getPcmPlayerPositionMs:playerId resolve:resolve reject:reject];
}

- (void)destroyPcmPlayer:(NSString *)playerId
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject {
  [self so_destroyPcmPlayer:playerId resolve:resolve reject:reject];
}

@end
