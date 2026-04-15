/**
 * NSDictionary options for TTS generation / streaming (parallel to Android TtsGenerationOptionsParser).
 */

#pragma once

#import <Foundation/Foundation.h>

#include "native/sherpa-onnx-tts-wrapper.h"
#include <optional>

NSString *TtsModelKindToNSString(sherpaonnx::TtsModelKind kind);

/** When options omit numSteps, matches Android / upstream GenerationConfig default. */
extern const int32_t kDefaultVoiceCloneNumSteps;

/**
 * Build VoiceCloneOptions from buffer-based reference audio.
 * The caller provides pre-resolved samples and sample rate from the pipeline registry.
 */
std::optional<sherpaonnx::VoiceCloneOptions> VoiceCloneOptionsFromBuffer(
    NSDictionary *options,
    const std::vector<float> &refSamples,
    int32_t refSampleRate,
    int32_t defaultNumSteps
);

/** Check if options contain a buffer-based voice clone (referenceAudioBufferId key). */
BOOL NSDictionaryHasVoiceCloneBuffer(NSDictionary *options);
