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

std::optional<sherpaonnx::VoiceCloneOptions> VoiceCloneOptionsFromNSDictionary(
    NSDictionary *options,
    int32_t defaultNumSteps
);

BOOL NSDictionaryHasValidReferenceAudio(NSDictionary *options);

NSString *SubtitleModeFromOptions(NSDictionary *options);
NSString *SubtitleGranularityFromOptions(NSDictionary *options);
BOOL IsCharacterGranularityRequested(NSDictionary *options);
BOOL ExportChunkTimelineOnly(NSDictionary *options);
