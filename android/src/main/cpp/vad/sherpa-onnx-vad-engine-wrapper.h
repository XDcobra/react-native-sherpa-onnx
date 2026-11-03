#ifndef SHERPA_ONNX_VAD_ENGINE_WRAPPER_H
#define SHERPA_ONNX_VAD_ENGINE_WRAPPER_H

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace sherpaonnx {

struct VadEngineInitializeResult {
  bool success = false;
  std::string error;
};

struct VadEngineSegment {
  int32_t startSample = 0;
  int32_t endSample = 0;
  int32_t durationMs = 0;
};

struct VadEngineConfig {
  std::string modelType;  // "silero_vad" | "ten_vad"
  std::string modelPath;
  int32_t sampleRate = 16000;
  int32_t numThreads = 1;
  std::string provider = "cpu";
  bool debug = false;
  double scoreThreshold = 0.5;
  int32_t minSilenceDurationMs = 250;
  int32_t minSpeechDurationMs = 250;
  int32_t maxSpeechDurationMs = 5000;
  int32_t windowSize = 512;
  float bufferSizeSeconds = 30.0f;
};

/**
 * Shared VoiceActivityDetector (C API). Paths resolved by JS/detect before init.
 * modelType: "silero_vad" | "ten_vad"
 */
class VadEngineWrapper {
 public:
  VadEngineWrapper();
  ~VadEngineWrapper();

  VadEngineWrapper(const VadEngineWrapper&) = delete;
  VadEngineWrapper& operator=(const VadEngineWrapper&) = delete;

  VadEngineInitializeResult initialize(const VadEngineConfig& config);

  void acceptWaveform(const float* samples, int32_t n);
  void flush();
  void reset();  // Reset + Clear
  bool isSpeechDetected() const;
  std::vector<VadEngineSegment> popSegments();

  int32_t sampleRate() const;
  int32_t windowSize() const;

  bool isInitialized() const;
  void release();

 private:
  class Impl;
  std::unique_ptr<Impl> pImpl;
};

}  // namespace sherpaonnx

#endif
