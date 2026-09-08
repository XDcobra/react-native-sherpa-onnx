#ifndef SHERPA_ONNX_DIARIZATION_WRAPPER_H
#define SHERPA_ONNX_DIARIZATION_WRAPPER_H

#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace sherpaonnx {

struct DiarizationInitializeResult {
  bool success = false;
  std::string error;
  std::string errorCode;
  int32_t sampleRate = 0;
  int32_t embeddingDim = 0;
};

struct DiarizationSegmentDto {
  float start = 0.f;
  float end = 0.f;
  int32_t speaker = 0;
};

struct DiarizationProcessResult {
  bool success = false;
  std::string error;
  std::string errorCode;
  std::vector<DiarizationSegmentDto> segments;
  int32_t numSpeakers = 0;
  int32_t sampleRate = 0;
  std::vector<int32_t> speakersPerFrame;
};

struct DiarizationClusterEmbeddingDto {
  int32_t speaker = 0;
  std::vector<float> embedding;
};

struct DiarizationProgressDto {
  float fraction = 0.f;
  std::string phase;
  int32_t current = 0;
  int32_t total = 0;
};

using DiarizationProgressFn =
    std::function<void(const DiarizationProgressDto&)>;

/**
 * Portable PIMPL facade over the decomposed diarization C++ core.
 * No jni.h — compiled on Android and iOS.
 */
class DiarizationWrapper {
 public:
  DiarizationWrapper();
  ~DiarizationWrapper();

  DiarizationInitializeResult initialize(
      const std::string& segmentationModel, const std::string& embeddingModel,
      float windowShiftRatio, int32_t numClusters, float threshold,
      float minDurationOn, float minDurationOff, int32_t numThreads,
      const std::optional<std::string>& provider, bool debug);

  DiarizationProcessResult processMonoSamples(
      const std::vector<float>& monoSamples, int32_t sampleRate,
      bool includeOverlap, const DiarizationProgressFn& onProgress);

  DiarizationProcessResult recluster(int32_t numClusters, float threshold);

  std::vector<DiarizationClusterEmbeddingDto> getClusterEmbeddings() const;

  void cancel();
  int32_t getSampleRate() const;
  bool isInitialized() const;
  void release();

 private:
  class Impl;
  std::unique_ptr<Impl> pImpl;
};

}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_DIARIZATION_WRAPPER_H
