#pragma once

#include "sherpa-onnx-vad-engine-wrapper.h"

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

struct VadRuntimeConfig {
  std::string modelType;
  std::string modelPath;
  int sampleRate = 16000;
  int numThreads = 1;
  std::string provider = "cpu";
  bool debug = false;
  double scoreThreshold = 0.5;
  int minSilenceDurationMs = 250;
  int minSpeechDurationMs = 250;
  int maxSpeechDurationMs = 5000;
  int windowSize = 512;
  float bufferSizeSeconds = 30.0f;
};

struct VadRuntimeSegment {
  int startSample = 0;
  int endSample = 0;
  int durationMs = 0;
};

/** Thin iOS facade over shared sherpaonnx::VadEngineWrapper. */
class VadRuntime {
public:
  ~VadRuntime() = default;

  static std::shared_ptr<VadRuntime> Create(
    const VadRuntimeConfig &config,
    std::string *errorOut
  );

  void AcceptWaveform(const float *samples, int32_t n) const;
  void Flush() const;
  void Reset() const;
  bool IsSpeechDetected() const;
  std::vector<VadRuntimeSegment> PopSegments() const;

private:
  explicit VadRuntime(std::shared_ptr<sherpaonnx::VadEngineWrapper> engine);
  std::shared_ptr<sherpaonnx::VadEngineWrapper> engine_;
};
