#pragma once

#include "AudioVisualization.h"

#include <cstdint>
#include <string>
#include <vector>

namespace sherpa {

/** Public format id mirrored by the TS API (`sherpa_viz_v1`). */
inline constexpr const char *kAudioVisualizationSidecarFormatId = "sherpa_viz_v1";

/** Binary container version written after the "SVIZ" magic. */
inline constexpr uint16_t kAudioVisualizationSidecarVersion = 1;

enum class AudioVisualizationSidecarKind : uint16_t {
  SPECTRUM_BARS = 0,
};

enum AudioVisualizationSidecarFlags : uint32_t {
  kAudioVisualizationSidecarFlagHasFrames = 1u << 0,
};

struct AudioVisualizationSidecarEncodeOptions {
  /** When false, omit timeline frames even if present on the profile. */
  bool includeFrames = true;
};

/**
 * Encode a visualization profile to the `sherpa_viz_v1` binary sidecar.
 * Returns empty vector and sets `errorOut` on failure.
 */
std::vector<uint8_t> encodeAudioVisualizationSidecar(
    const AudioVisualizationProfile &profile,
    const AudioVisualizationSidecarEncodeOptions &options,
    std::string *errorOut);

/**
 * Decode a `sherpa_viz_v1` sidecar into a profile.
 * When `strict` is true, reject unknown magic/version/kind.
 * Returns false and sets `errorOut` on failure.
 */
bool decodeAudioVisualizationSidecar(
    const uint8_t *data,
    size_t size,
    bool strict,
    AudioVisualizationProfile *outProfile,
    std::string *errorOut);

}  // namespace sherpa
