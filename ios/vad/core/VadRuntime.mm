#include "VadRuntime.h"

#include "../../../third_party/sherpa-onnx/sherpa-onnx/c-api/c-api.h"

#include <algorithm>
#include <cstring>

namespace {
int SamplesToMs(int samples, int sampleRate) {
  return static_cast<int>((static_cast<int64_t>(samples) * 1000LL) /
                          std::max(1, sampleRate));
}
} // namespace

VadRuntime::VadRuntime(const void *detector, int sampleRate)
  : detector_(detector), sampleRate_(sampleRate) {}

VadRuntime::~VadRuntime() {
  if (detector_ != nullptr) {
    SherpaOnnxDestroyVoiceActivityDetector(
      reinterpret_cast<const SherpaOnnxVoiceActivityDetector *>(detector_)
    );
    detector_ = nullptr;
  }
}

std::shared_ptr<VadRuntime> VadRuntime::Create(
  const VadRuntimeConfig &config,
  std::string *errorOut
) {
  if (config.modelPath.empty()) {
    if (errorOut) *errorOut = "VAD model path is empty";
    return nullptr;
  }

  SherpaOnnxVadModelConfig modelConfig;
  std::memset(&modelConfig, 0, sizeof(modelConfig));
  modelConfig.sample_rate = std::max(1, config.sampleRate);
  modelConfig.num_threads = std::max(1, config.numThreads);
  modelConfig.provider = config.provider.c_str();
  modelConfig.debug = config.debug ? 1 : 0;

  const float threshold = static_cast<float>(std::max(0.0, config.scoreThreshold));
  const float minSilence =
      static_cast<float>(std::max(0, config.minSilenceDurationMs)) / 1000.0f;
  const float minSpeech =
      static_cast<float>(std::max(0, config.minSpeechDurationMs)) / 1000.0f;
  const float maxSpeech =
      static_cast<float>(std::max(0, config.maxSpeechDurationMs)) / 1000.0f;
  const int windowSize = std::max(1, config.windowSize);

  if (config.modelType == "ten_vad") {
    modelConfig.ten_vad.model = config.modelPath.c_str();
    modelConfig.ten_vad.threshold = threshold;
    modelConfig.ten_vad.min_silence_duration = minSilence;
    modelConfig.ten_vad.min_speech_duration = minSpeech;
    modelConfig.ten_vad.window_size = windowSize;
    modelConfig.ten_vad.max_speech_duration = maxSpeech;
  } else {
    modelConfig.silero_vad.model = config.modelPath.c_str();
    modelConfig.silero_vad.threshold = threshold;
    modelConfig.silero_vad.min_silence_duration = minSilence;
    modelConfig.silero_vad.min_speech_duration = minSpeech;
    modelConfig.silero_vad.window_size = windowSize;
    modelConfig.silero_vad.max_speech_duration = maxSpeech;
  }

  const SherpaOnnxVoiceActivityDetector *detector =
      SherpaOnnxCreateVoiceActivityDetector(
          &modelConfig,
          std::max(1.0f, config.bufferSizeSeconds));
  if (detector == nullptr) {
    if (errorOut) *errorOut = "SherpaOnnxCreateVoiceActivityDetector returned null";
    return nullptr;
  }

  return std::shared_ptr<VadRuntime>(
      new VadRuntime(detector, modelConfig.sample_rate));
}

void VadRuntime::AcceptWaveform(const float *samples, int32_t n) const {
  if (detector_ == nullptr || samples == nullptr || n <= 0) return;
  SherpaOnnxVoiceActivityDetectorAcceptWaveform(
    reinterpret_cast<const SherpaOnnxVoiceActivityDetector *>(detector_),
    samples,
    n
  );
}

void VadRuntime::Flush() const {
  if (detector_ == nullptr) return;
  SherpaOnnxVoiceActivityDetectorFlush(
    reinterpret_cast<const SherpaOnnxVoiceActivityDetector *>(detector_)
  );
}

void VadRuntime::Reset() const {
  if (detector_ == nullptr) return;
  SherpaOnnxVoiceActivityDetectorReset(
    reinterpret_cast<const SherpaOnnxVoiceActivityDetector *>(detector_)
  );
  SherpaOnnxVoiceActivityDetectorClear(
    reinterpret_cast<const SherpaOnnxVoiceActivityDetector *>(detector_)
  );
}

bool VadRuntime::IsSpeechDetected() const {
  if (detector_ == nullptr) return false;
  return SherpaOnnxVoiceActivityDetectorDetected(
             reinterpret_cast<const SherpaOnnxVoiceActivityDetector *>(detector_)) == 1;
}

std::vector<VadRuntimeSegment> VadRuntime::PopSegments() const {
  std::vector<VadRuntimeSegment> out;
  if (detector_ == nullptr) return out;
  const auto *detector =
    reinterpret_cast<const SherpaOnnxVoiceActivityDetector *>(detector_);
  while (SherpaOnnxVoiceActivityDetectorEmpty(detector) == 0) {
    const SherpaOnnxSpeechSegment *segment =
      SherpaOnnxVoiceActivityDetectorFront(detector);
    if (segment != nullptr) {
      VadRuntimeSegment item;
      item.startSample = segment->start;
      item.endSample = segment->start + segment->n;
      item.durationMs = SamplesToMs(segment->n, sampleRate_);
      out.push_back(item);
      SherpaOnnxDestroySpeechSegment(segment);
    }
    SherpaOnnxVoiceActivityDetectorPop(detector);
  }
  return out;
}
