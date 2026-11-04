/**
 * NSDictionary options for TTS generation / streaming (parallel to Android TtsGenerationOptionsParser).
 */

#pragma once

#import <Foundation/Foundation.h>

#include "sherpa-onnx-tts-engine-wrapper.h"
#include <memory>
#include <optional>
#include <string>
#include <vector>

NSString *TtsModelKindToNSString(sherpaonnx::TtsModelKind kind);

/** When options omit numSteps, matches Android / upstream GenerationConfig default. */
extern const int32_t kDefaultVoiceCloneNumSteps;

/**
 * Build VoiceCloneOptions from buffer-based reference audio.
 * The caller provides pre-resolved samples and sample rate from the pipeline registry.
 */
/** Non-owning PCM. `keepalive` must keep `refSamples` valid through generate(). */
std::optional<sherpaonnx::VoiceCloneOptions> VoiceCloneOptionsFromBuffer(
    NSDictionary *options,
    const float *refSamples,
    int32_t refSampleCount,
    int32_t refSampleRate,
    int32_t defaultNumSteps,
    std::shared_ptr<void> keepalive
);

/** Check if options contain a buffer-based voice clone (referenceAudioBufferId key). */
BOOL NSDictionaryHasVoiceCloneBuffer(NSDictionary *options);

BOOL NSDictionaryHasNumSteps(NSDictionary *options);

int32_t NumStepsFromNSDictionary(NSDictionary *options, int32_t defaultNumSteps);

BOOL TtsModelKindSupportsNumSteps(sherpaonnx::TtsModelKind kind);

BOOL TtsModelKindRequiresVoiceCloneForNumSteps(sherpaonnx::TtsModelKind kind);

/**
 * Build VoiceCloneOptions for non-clone GenerationConfig (runtime `lang` / `extra`,
 * `numSteps`, and/or `phonemeCodepoints` / `tokens`).
 */
std::optional<sherpaonnx::VoiceCloneOptions> GenerationExtraFromOptions(NSDictionary *options);

BOOL NSDictionaryHasPhonemeInput(NSDictionary *options);

void ApplyPhonemeInputFromNSDictionary(
    NSDictionary *options,
    sherpaonnx::VoiceCloneOptions *out
);

std::vector<std::vector<int32_t>> PhonemeCodepointsFromId(id value);
std::vector<std::vector<std::string>> TokensFromId(id value);
