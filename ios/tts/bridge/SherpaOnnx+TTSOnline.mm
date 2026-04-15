#import "../../SherpaOnnx.h"
#include "engine/TtsEngineStore.h"
#include "pipeline/TtsPipelineWorker.h"
#include "options/TtsGenerationOptionsHelpers.h"
#include "../../pipeline/core/SherpaOnnx+StreamingPipeline.h"
#include "../../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "../../textbuffer/core/SherpaOnnx+TextBufferGlobals.h"
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
@end

@implementation SherpaOnnx (TTSOnline)

- (void)startTtsPipeline:(NSString *)instanceId
     textInLiveBufferId:(NSString *)textInLiveBufferId
    audioOutLiveBufferId:(NSString *)audioOutLiveBufferId
                 options:(NSDictionary *)options
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

    std::string instanceKey = [instanceId UTF8String];
    std::string textBufferKey = [textInLiveBufferId UTF8String];
    std::string audioBufferKey = [audioOutLiveBufferId UTF8String];

    // Look up TTS engine
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

    // Look up input text buffer
    auto inputEntry = txt_get_live_entry(textBufferKey);
    if (!inputEntry) {
        reject(@"TTS_PIPELINE_TEXT_BUFFER_NOT_FOUND",
               [NSString stringWithFormat:@"Input live text buffer not found: %@", textInLiveBufferId], nil);
        return;
    }

    // Look up output audio buffer
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

    // Validate states
    if (!txt_live_is_recording(inputEntry)) {
        reject(@"TTS_PIPELINE_BUFFER_NOT_RECORDING", @"Input text buffer is not in recording state", nil);
        return;
    }
    if (outputEntry->state != PaLiveEntry::RECORDING) {
        reject(@"TTS_PIPELINE_BUFFER_NOT_RECORDING", @"Output audio buffer is not in recording state", nil);
        return;
    }

    // Validate sample rate
    int ttsSampleRate = inst->wrapper->getSampleRate();
    if (outputEntry->sampleRate != ttsSampleRate) {
        reject(@"TTS_PIPELINE_SAMPLE_RATE_MISMATCH",
               [NSString stringWithFormat:@"Output buffer sample rate (%d) does not match TTS model sample rate (%d)",
                outputEntry->sampleRate, ttsSampleRate], nil);
        return;
    }

    // Check for existing pipeline
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

    // Parse options
    int32_t defaultSid = 0;
    float defaultSpeed = 1.0f;
    if (options) {
        NSNumber *sidVal = options[@"sid"];
        if (sidVal) defaultSid = [sidVal intValue];
        NSNumber *speedVal = options[@"speed"];
        if (speedVal) defaultSpeed = [speedVal floatValue];
    }

    // Resolve voice cloning
    std::optional<sherpaonnx::VoiceCloneOptions> voiceClone;
    if (options) {
        NSString *refBufferId = options[@"referenceAudioBufferId"];
        if (refBufferId && [refBufferId length] > 0) {
            std::string refKey = [refBufferId UTF8String];

            auto modelKind = inst->wrapper->getModelKind();
            if (modelKind != sherpaonnx::TtsModelKind::Pocket) {
                reject(@"TTS_PIPELINE_VOICE_CLONE_UNSUPPORTED",
                       @"Voice cloning in pipeline mode is only supported for Pocket TTS", nil);
                return;
            }

            std::shared_ptr<PaOfflineEntry> refEntry;
            {
                std::lock_guard<std::mutex> lock(g_pa_mutex);
                auto it = g_pa_offline.find(refKey);
                if (it == g_pa_offline.end() || !it->second) {
                    reject(@"TTS_PIPELINE_VOICE_CLONE_REF_NOT_FOUND",
                           [NSString stringWithFormat:@"Reference audio buffer not found: %@", refBufferId], nil);
                    return;
                }
                refEntry = it->second;
            }

            auto refSamples = refEntry->readAllSamples();
            int32_t refSampleRate = refEntry->sampleRate;

            sherpaonnx::VoiceCloneOptions clone;
            clone.reference_audio = std::move(refSamples);
            clone.reference_sample_rate = refSampleRate;
            clone.reference_text = options[@"referenceText"]
                ? std::string([options[@"referenceText"] UTF8String] ?: "")
                : "";
            clone.silence_scale = options[@"silenceScale"]
                ? [options[@"silenceScale"] floatValue]
                : 0.2f;
            clone.num_steps = options[@"numSteps"]
                ? [options[@"numSteps"] intValue]
                : kDefaultVoiceCloneNumSteps;

            voiceClone = std::move(clone);
        }
    }

    try {
        auto worker = std::make_shared<TtsPipelineWorker>(
            inst->wrapper.get(),
            inputEntry,
            outputEntry,
            defaultSid,
            defaultSpeed,
            std::move(voiceClone)
        );

        {
            std::lock_guard<std::mutex> lock(g_streaming_pipeline_mutex);
            g_streaming_pipelines[worker->pipelineId] = worker;
        }
        worker->start();

        {
            std::lock_guard<std::mutex> tpLock(g_tts_pipeline_mutex);
            g_tts_instance_to_pipeline[instanceKey] = worker->pipelineId;
        }

        resolve(@{ @"pipelineId": [NSString stringWithUTF8String:worker->pipelineId.c_str()] });
    } catch (const std::exception &e) {
        reject(@"STREAMING_PIPELINE_ERROR", [NSString stringWithUTF8String:e.what()], nil);
    } catch (...) {
        reject(@"STREAMING_PIPELINE_ERROR", @"Failed to start TTS pipeline", nil);
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
