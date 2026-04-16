/**
 * SherpaOnnx+TTSBatch.mm — Buffer-to-buffer offline TTS synthesis.
 */

#import "../../SherpaOnnx.h"
#import <React/RCTLog.h>

#include "engine/TtsEngineStore.h"
#include "options/TtsGenerationOptionsHelpers.h"
#include "native/sherpa-onnx-tts-wrapper.h"
#include "../../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "../../textbuffer/core/SherpaOnnx+TextBufferGlobals.h"

#include <memory>
#include <optional>
#include <string>
#include <vector>

@implementation SherpaOnnx (TTSBatch)

static NSString *const kOfflineOomCode = @"OFFLINE_OOM";
static NSString *const kOfflineTtsOomMessage =
    @"Not enough memory for offline text-to-speech. Please use a streaming mode for large inputs.";

- (void)so_synthesizeTts:(NSString *)instanceId
         textInBufferId:(NSString *)textInBufferId
        audioOutBufferId:(NSString *)audioOutBufferId
                 options:(NSDictionary *)options
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
    if (instanceId == nil || [instanceId length] == 0) {
        reject(@"TTS_GENERATE_ERROR", @"instanceId is required", nil);
        return;
    }
    if (textInBufferId == nil || [textInBufferId length] == 0) {
        reject(@"TTS_TEXT_BUFFER_NOT_FOUND", @"textInBufferId is required", nil);
        return;
    }
    if (audioOutBufferId == nil || [audioOutBufferId length] == 0) {
        reject(@"TTS_AUDIO_OUT_NOT_FOUND", @"audioOutBufferId is required", nil);
        return;
    }

    std::string instanceIdStr = [instanceId UTF8String];
    std::string textInIdStr = [textInBufferId UTF8String];
    std::string audioOutIdStr = [audioOutBufferId UTF8String];

    // 1. Resolve TTS engine
    std::lock_guard<std::mutex> ttsLock(g_tts_mutex);
    auto ttsIt = g_tts_instances.find(instanceIdStr);
    if (ttsIt == g_tts_instances.end() || ttsIt->second->wrapper == nullptr || !ttsIt->second->wrapper->isInitialized()) {
        reject(@"TTS_GENERATE_ERROR", @"TTS not initialized. Call initializeTts() first.", nil);
        return;
    }
    sherpaonnx::TtsWrapper *wrapper = ttsIt->second->wrapper.get();

    // 2. Resolve input text buffer
    if (textInIdStr.find("txt_off_") != 0) {
        reject(@"TTS_TEXT_BUFFER_KIND_MISMATCH",
               [NSString stringWithFormat:@"Expected offline text buffer (txt_off_*), got: %@", textInBufferId], nil);
        return;
    }
    std::string text;
    std::string textError;
    if (!txt_read_offline_text(textInIdStr, &text, &textError)) {
        NSString *msg = [NSString stringWithUTF8String:textError.c_str()] ?: @"Text buffer read failed";
        NSString *code = [msg containsString:@"not found"] ? @"TTS_TEXT_BUFFER_NOT_FOUND" : @"TTS_TEXT_BUFFER_EMPTY";
        reject(code, msg, nil);
        return;
    }

    // 3. Resolve output audio buffer
    if (audioOutIdStr.find("off_") != 0) {
        reject(@"TTS_AUDIO_OUT_KIND_MISMATCH",
               [NSString stringWithFormat:@"Expected offline audio buffer (off_*), got: %@", audioOutBufferId], nil);
        return;
    }
    int audioOutSampleRate = 0;
    int audioOutNumSamples = 0;
    std::string paErrCode;
    std::string paErrMsg;
    if (!pa_get_offline_metadata(audioOutIdStr, &audioOutSampleRate, &audioOutNumSamples, &paErrCode, &paErrMsg)) {
        reject(@"TTS_AUDIO_OUT_NOT_FOUND",
               [NSString stringWithFormat:@"Offline audio buffer not found: %@", audioOutBufferId], nil);
        return;
    }
    if (audioOutNumSamples != 0) {
        reject(@"TTS_AUDIO_OUT_ALREADY_POPULATED",
               [NSString stringWithFormat:@"Audio output buffer is already populated: %@", audioOutBufferId], nil);
        return;
    }

    // 4. Sample rate strict check
    int32_t modelSampleRate = wrapper->getSampleRate();
    if (modelSampleRate > 0 && audioOutSampleRate != modelSampleRate) {
        reject(@"TTS_OUTPUT_SAMPLE_RATE_MISMATCH",
               [NSString stringWithFormat:@"audioOut.sampleRate (%d) != model sampleRate (%d). Allocate with getTtsSampleRate() or tts.getSampleRate().",
                audioOutSampleRate, modelSampleRate], nil);
        return;
    }

    @try {
        // 5. Parse generation options
        double sid = 0;
        double speed = 1.0;
        if (options != nil) {
            if (options[@"sid"] != nil) sid = [options[@"sid"] doubleValue];
            if (options[@"speed"] != nil) speed = [options[@"speed"] doubleValue];
        }

        using Kind = sherpaonnx::TtsModelKind;
        Kind kind = wrapper->getModelKind();

        // 6. Handle voice cloning with OfflineAudioBuffer reference
        std::optional<sherpaonnx::VoiceCloneOptions> cloneOpt;
        if (NSDictionaryHasVoiceCloneBuffer(options)) {
            if (kind != Kind::kZipvoice && kind != Kind::kPocket) {
                reject(@"TTS_GENERATE_ERROR", @"Reference audio is only supported for Zipvoice and Pocket TTS.", nil);
                return;
            }
            NSString *refBufferIdNS = options[@"referenceAudioBufferId"];
            if (refBufferIdNS == nil || ![refBufferIdNS isKindOfClass:[NSString class]] || [refBufferIdNS length] == 0) {
                reject(@"TTS_REFERENCE_AUDIO_BUFFER_NOT_FOUND",
                       @"referenceAudioBufferId is required for voice cloning", nil);
                return;
            }
            std::string refBufferId = [refBufferIdNS UTF8String];
            std::vector<float> refSamples;
            int32_t refSampleRate = 0;
            if (refBufferId.find("off_") != 0) {
                reject(@"TTS_REFERENCE_AUDIO_BUFFER_KIND_MISMATCH",
                       [NSString stringWithFormat:@"Expected offline audio buffer for reference, got: %@", refBufferIdNS], nil);
                return;
            }
            int tmpSr = 0;
            if (!pa_read_offline_samples(refBufferId, &refSamples, &tmpSr)) {
                reject(@"TTS_REFERENCE_AUDIO_BUFFER_NOT_FOUND",
                       [NSString stringWithFormat:@"Reference audio buffer not found: %@", refBufferIdNS], nil);
                return;
            }
            refSampleRate = tmpSr;
            if (kind == Kind::kZipvoice) {
                NSString *rt = options[@"referenceText"];
                NSString *trimmed = rt != nil ? [rt stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] : @"";
                if ([trimmed length] == 0) {
                    reject(@"TTS_GENERATE_ERROR", @"Zipvoice voice cloning requires non-empty referenceText.", nil);
                    return;
                }
            }
            cloneOpt = VoiceCloneOptionsFromBuffer(options, refSamples, refSampleRate, kDefaultVoiceCloneNumSteps);
        } else if (kind == Kind::kPocket) {
            reject(@"TTS_GENERATE_ERROR", @"Pocket TTS requires reference audio for voice cloning. Pass voiceClone in options.", nil);
            return;
        }

        auto result = wrapper->generate(
            text,
            static_cast<int32_t>(sid),
            static_cast<float>(speed),
            cloneOpt
        );

        if (result.samples.empty() || result.sampleRate == 0) {
            reject(@"TTS_GENERATE_ERROR", @"TTS generated empty audio", nil);
            return;
        }

        // 7. Adopt samples into the output buffer (move)
        {
            std::string adoptErrCode;
            std::string adoptErrMsg;
            if (!pa_adopt_offline_samples_if_empty(audioOutIdStr, std::move(result.samples), &adoptErrCode, &adoptErrMsg)) {
                reject(@"TTS_AUDIO_OUT_ALREADY_POPULATED",
                       [NSString stringWithFormat:@"Audio output buffer was populated concurrently: %@", audioOutBufferId], nil);
                return;
            }
        }

        // Upgrade to mmap if it exceeds the threshold
        pa_upgradeToMmapIfNeeded(audioOutIdStr);

        resolve([NSNull null]);
    } @catch (NSException *exception) {
        NSString *reason = exception.reason ?: @"";
        NSString *reasonLower = [reason lowercaseString];
        if ([reasonLower containsString:@"memory"] || [reasonLower containsString:@"alloc"]) {
            reject(kOfflineOomCode, kOfflineTtsOomMessage, nil);
            return;
        }
        NSString *errorMsg = [NSString stringWithFormat:@"Exception during TTS synthesis: %@", exception.reason];
        RCTLogError(@"%@", errorMsg);
        reject(@"TTS_GENERATE_ERROR", errorMsg, nil);
    }
}

@end
