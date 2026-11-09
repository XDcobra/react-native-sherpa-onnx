#include "AudioVisualizationSidecar.h"

#include <cstring>
#include <limits>

namespace sherpa {
namespace {

constexpr char kMagic[4] = {'S', 'V', 'I', 'Z'};
constexpr size_t kHeaderSize = 48;
constexpr int kMaxBarCount = 512;
constexpr int kMaxFrameCount = 512;
constexpr size_t kMaxFloatPayload = 131072;

void appendU16(std::vector<uint8_t> &out, uint16_t value) {
  out.push_back(static_cast<uint8_t>(value & 0xffu));
  out.push_back(static_cast<uint8_t>((value >> 8) & 0xffu));
}

void appendU32(std::vector<uint8_t> &out, uint32_t value) {
  out.push_back(static_cast<uint8_t>(value & 0xffu));
  out.push_back(static_cast<uint8_t>((value >> 8) & 0xffu));
  out.push_back(static_cast<uint8_t>((value >> 16) & 0xffu));
  out.push_back(static_cast<uint8_t>((value >> 24) & 0xffu));
}

void appendF32(std::vector<uint8_t> &out, float value) {
  uint32_t bits = 0;
  static_assert(sizeof(float) == sizeof(uint32_t), "float must be 32-bit");
  std::memcpy(&bits, &value, sizeof(bits));
  appendU32(out, bits);
}

void appendF64(std::vector<uint8_t> &out, double value) {
  uint64_t bits = 0;
  static_assert(sizeof(double) == sizeof(uint64_t), "double must be 64-bit");
  std::memcpy(&bits, &value, sizeof(bits));
  for (int i = 0; i < 8; ++i) {
    out.push_back(static_cast<uint8_t>((bits >> (8 * i)) & 0xffu));
  }
}

bool readU16(const uint8_t *data, size_t size, size_t *offset, uint16_t *out) {
  if (*offset + 2 > size) {
    return false;
  }
  *out = static_cast<uint16_t>(data[*offset]) |
         (static_cast<uint16_t>(data[*offset + 1]) << 8);
  *offset += 2;
  return true;
}

bool readU32(const uint8_t *data, size_t size, size_t *offset, uint32_t *out) {
  if (*offset + 4 > size) {
    return false;
  }
  *out = static_cast<uint32_t>(data[*offset]) |
         (static_cast<uint32_t>(data[*offset + 1]) << 8) |
         (static_cast<uint32_t>(data[*offset + 2]) << 16) |
         (static_cast<uint32_t>(data[*offset + 3]) << 24);
  *offset += 4;
  return true;
}

bool readF32(const uint8_t *data, size_t size, size_t *offset, float *out) {
  uint32_t bits = 0;
  if (!readU32(data, size, offset, &bits)) {
    return false;
  }
  std::memcpy(out, &bits, sizeof(*out));
  return true;
}

bool readF64(const uint8_t *data, size_t size, size_t *offset, double *out) {
  if (*offset + 8 > size) {
    return false;
  }
  uint64_t bits = 0;
  for (int i = 0; i < 8; ++i) {
    bits |= static_cast<uint64_t>(data[*offset + static_cast<size_t>(i)])
            << (8 * i);
  }
  *offset += 8;
  std::memcpy(out, &bits, sizeof(*out));
  return true;
}

float clampUnit(float value) {
  if (!(value > 0.0F)) {
    return 0.0F;
  }
  if (value >= 1.0F) {
    return 1.0F;
  }
  return value;
}

}  // namespace

std::vector<uint8_t> encodeAudioVisualizationSidecar(
    const AudioVisualizationProfile &profile,
    const AudioVisualizationSidecarEncodeOptions &options,
    std::string *errorOut) {
  if (errorOut) {
    errorOut->clear();
  }

  if (profile.barCount <= 0 || profile.barCount > kMaxBarCount) {
    if (errorOut) {
      *errorOut =
          "AUDIO_VISUALIZATION_INVALID_PROFILE: barCount out of range";
    }
    return {};
  }
  if (static_cast<int>(profile.levels.size()) < profile.barCount) {
    if (errorOut) {
      *errorOut =
          "AUDIO_VISUALIZATION_INVALID_PROFILE: levels shorter than barCount";
    }
    return {};
  }
  if (profile.sampleRate < 0) {
    if (errorOut) {
      *errorOut =
          "AUDIO_VISUALIZATION_INVALID_PROFILE: sampleRate must be >= 0";
    }
    return {};
  }
  if (profile.durationMs < 0) {
    if (errorOut) {
      *errorOut =
          "AUDIO_VISUALIZATION_INVALID_PROFILE: durationMs must be >= 0";
    }
    return {};
  }

  const bool writeFrames = options.includeFrames && profile.frameCount > 0 &&
                           !profile.frames.empty();
  int frameCount = 0;
  double frameDurationMs = 0.0;
  if (writeFrames) {
    frameCount = profile.frameCount;
    if (frameCount <= 0 || frameCount > kMaxFrameCount) {
      if (errorOut) {
        *errorOut =
            "AUDIO_VISUALIZATION_INVALID_PROFILE: frameCount out of range";
      }
      return {};
    }
    const size_t expected =
        static_cast<size_t>(frameCount) * static_cast<size_t>(profile.barCount);
    if (expected > kMaxFloatPayload) {
      if (errorOut) {
        *errorOut =
            "AUDIO_VISUALIZATION_PAYLOAD_TOO_LARGE: frameCount * barCount exceeds 131072";
      }
      return {};
    }
    if (profile.frames.size() < expected) {
      if (errorOut) {
        *errorOut =
            "AUDIO_VISUALIZATION_INVALID_PROFILE: frames shorter than frameCount * barCount";
      }
      return {};
    }
    frameDurationMs = profile.frameDurationMs;
    if (!(frameDurationMs >= 0.0) ||
        frameDurationMs > static_cast<double>(std::numeric_limits<float>::max())) {
      if (errorOut) {
        *errorOut =
            "AUDIO_VISUALIZATION_INVALID_PROFILE: frameDurationMs invalid";
      }
      return {};
    }
  }

  uint32_t flags = 0;
  if (writeFrames) {
    flags |= kAudioVisualizationSidecarFlagHasFrames;
  }

  std::vector<uint8_t> out;
  out.reserve(
      kHeaderSize +
      static_cast<size_t>(profile.barCount) * sizeof(float) +
      (writeFrames
           ? static_cast<size_t>(frameCount) * static_cast<size_t>(profile.barCount) *
                 sizeof(float)
           : 0));

  out.insert(out.end(), kMagic, kMagic + 4);
  appendU16(out, kAudioVisualizationSidecarVersion);
  appendU16(out, static_cast<uint16_t>(AudioVisualizationSidecarKind::SPECTRUM_BARS));
  appendU32(out, flags);
  appendU32(out, static_cast<uint32_t>(profile.barCount));
  appendU32(out, static_cast<uint32_t>(profile.sampleRate));
  appendF64(out, static_cast<double>(profile.durationMs));
  appendU32(out, static_cast<uint32_t>(frameCount));
  appendF64(out, frameDurationMs);
  appendU32(out, 0);  // reserved
  appendU32(out, 0);  // reserved

  for (int i = 0; i < profile.barCount; ++i) {
    appendF32(out, clampUnit(profile.levels[static_cast<size_t>(i)]));
  }

  if (writeFrames) {
    const size_t expected =
        static_cast<size_t>(frameCount) * static_cast<size_t>(profile.barCount);
    for (size_t i = 0; i < expected; ++i) {
      appendF32(out, clampUnit(profile.frames[i]));
    }
  }

  return out;
}

bool decodeAudioVisualizationSidecar(
    const uint8_t *data,
    size_t size,
    bool strict,
    AudioVisualizationProfile *outProfile,
    std::string *errorOut) {
  if (errorOut) {
    errorOut->clear();
  }
  if (!outProfile) {
    if (errorOut) {
      *errorOut = "AUDIO_VISUALIZATION_INVALID_PROFILE: null output";
    }
    return false;
  }
  if (!data || size < kHeaderSize) {
    if (errorOut) {
      *errorOut = "AUDIO_VISUALIZATION_SIDECAR_INVALID: truncated header";
    }
    return false;
  }

  if (std::memcmp(data, kMagic, 4) != 0) {
    if (errorOut) {
      *errorOut = "AUDIO_VISUALIZATION_SIDECAR_INVALID: bad magic";
    }
    return false;
  }

  size_t offset = 4;
  uint16_t version = 0;
  uint16_t kind = 0;
  uint32_t flags = 0;
  uint32_t barCountU = 0;
  uint32_t sampleRateU = 0;
  double durationMs = 0.0;
  uint32_t frameCountU = 0;
  double frameDurationMs = 0.0;
  uint32_t reserved0 = 0;
  uint32_t reserved1 = 0;

  if (!readU16(data, size, &offset, &version) ||
      !readU16(data, size, &offset, &kind) ||
      !readU32(data, size, &offset, &flags) ||
      !readU32(data, size, &offset, &barCountU) ||
      !readU32(data, size, &offset, &sampleRateU) ||
      !readF64(data, size, &offset, &durationMs) ||
      !readU32(data, size, &offset, &frameCountU) ||
      !readF64(data, size, &offset, &frameDurationMs) ||
      !readU32(data, size, &offset, &reserved0) ||
      !readU32(data, size, &offset, &reserved1)) {
    if (errorOut) {
      *errorOut = "AUDIO_VISUALIZATION_SIDECAR_INVALID: truncated header fields";
    }
    return false;
  }

  if (version != kAudioVisualizationSidecarVersion) {
    if (strict || version == 0) {
      if (errorOut) {
        *errorOut = "AUDIO_VISUALIZATION_SIDECAR_UNSUPPORTED: version";
      }
      return false;
    }
  }

  if (kind != static_cast<uint16_t>(AudioVisualizationSidecarKind::SPECTRUM_BARS)) {
    if (strict) {
      if (errorOut) {
        *errorOut = "AUDIO_VISUALIZATION_SIDECAR_UNSUPPORTED: kind";
      }
      return false;
    }
  }

  if (barCountU == 0 || barCountU > static_cast<uint32_t>(kMaxBarCount)) {
    if (errorOut) {
      *errorOut = "AUDIO_VISUALIZATION_SIDECAR_INVALID: barCount";
    }
    return false;
  }

  const bool hasFrames =
      (flags & kAudioVisualizationSidecarFlagHasFrames) != 0;
  if (hasFrames) {
    if (frameCountU == 0 || frameCountU > static_cast<uint32_t>(kMaxFrameCount)) {
      if (errorOut) {
        *errorOut = "AUDIO_VISUALIZATION_SIDECAR_INVALID: frameCount";
      }
      return false;
    }
    const size_t expected =
        static_cast<size_t>(frameCountU) * static_cast<size_t>(barCountU);
    if (expected > kMaxFloatPayload) {
      if (errorOut) {
        *errorOut =
            "AUDIO_VISUALIZATION_PAYLOAD_TOO_LARGE: frameCount * barCount exceeds 131072";
      }
      return false;
    }
  } else if (frameCountU != 0 && strict) {
    if (errorOut) {
      *errorOut =
          "AUDIO_VISUALIZATION_SIDECAR_INVALID: frameCount set without HAS_FRAMES";
    }
    return false;
  }

  AudioVisualizationProfile profile;
  profile.sampleRate = static_cast<int>(sampleRateU);
  profile.durationMs = durationMs > 0.0 ? static_cast<int64_t>(durationMs) : 0;
  profile.barCount = static_cast<int>(barCountU);
  profile.levels.assign(static_cast<size_t>(barCountU), 0.0F);

  for (uint32_t i = 0; i < barCountU; ++i) {
    float value = 0.0F;
    if (!readF32(data, size, &offset, &value)) {
      if (errorOut) {
        *errorOut = "AUDIO_VISUALIZATION_SIDECAR_INVALID: truncated levels";
      }
      return false;
    }
    profile.levels[static_cast<size_t>(i)] = clampUnit(value);
  }

  if (hasFrames) {
    const size_t expected =
        static_cast<size_t>(frameCountU) * static_cast<size_t>(barCountU);
    profile.frameCount = static_cast<int>(frameCountU);
    profile.frameDurationMs = frameDurationMs > 0.0 ? frameDurationMs : 0.0;
    profile.frames.resize(expected);
    for (size_t i = 0; i < expected; ++i) {
      float value = 0.0F;
      if (!readF32(data, size, &offset, &value)) {
        if (errorOut) {
          *errorOut = "AUDIO_VISUALIZATION_SIDECAR_INVALID: truncated frames";
        }
        return false;
      }
      profile.frames[i] = clampUnit(value);
    }
  } else {
    profile.frameCount = 0;
    profile.frameDurationMs = 0.0;
    profile.frames.clear();
  }

  *outProfile = std::move(profile);
  return true;
}

}  // namespace sherpa
