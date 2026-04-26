#pragma once

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

class VadRuntime {
public:
  ~VadRuntime();

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
  VadRuntime(const void *detector, int sampleRate);
  const void *detector_ = nullptr;
  int sampleRate_ = 16000;
};
