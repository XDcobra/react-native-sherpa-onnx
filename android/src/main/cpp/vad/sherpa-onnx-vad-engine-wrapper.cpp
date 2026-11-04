#include "sherpa-onnx-vad-engine-wrapper.h"

#include <algorithm>
#include <cstdio>
#include <cstring>

#include "sherpa-onnx/c-api/c-api.h"

#ifdef __ANDROID__
#include <android/log.h>
#define VAD_LOGI(...) \
  __android_log_print(ANDROID_LOG_INFO, "SherpaOnnx:vad", __VA_ARGS__)
#define VAD_LOGE(...) \
  __android_log_print(ANDROID_LOG_ERROR, "SherpaOnnx:vad", __VA_ARGS__)
#elif defined(__APPLE__)
#define VAD_LOGI(...)                                          \
  do {                                                         \
    std::fprintf(stderr, "[SherpaOnnx:vad] ");                 \
    std::fprintf(stderr, __VA_ARGS__);                         \
    std::fprintf(stderr, "\n");                                \
  } while (0)
#define VAD_LOGE(...) VAD_LOGI(__VA_ARGS__)
#else
#define VAD_LOGI(...) ((void)0)
#define VAD_LOGE(...) ((void)0)
#endif

namespace sherpaonnx {
namespace {

int32_t SamplesToMs(int32_t samples, int32_t sampleRate) {
  return static_cast<int32_t>((static_cast<int64_t>(samples) * 1000LL) /
                              std::max(1, sampleRate));
}

}  // namespace

class VadEngineWrapper::Impl {
 public:
  ~Impl() { release(); }

  VadEngineInitializeResult initialize(const VadEngineConfig& config) {
    release();
    VadEngineInitializeResult out;
    if (config.modelPath.empty()) {
      out.error = "VAD model path is empty";
      VAD_LOGE("init fail: %s", out.error.c_str());
      return out;
    }
    if (config.modelType != "silero_vad" && config.modelType != "ten_vad") {
      out.error = "modelType must be silero_vad or ten_vad";
      VAD_LOGE("init fail: %s", out.error.c_str());
      return out;
    }

    modelType_ = config.modelType;
    modelPath_ = config.modelPath;
    provider_ = config.provider.empty() ? "cpu" : config.provider;
    sampleRate_ = std::max(1, config.sampleRate);
    windowSize_ = std::max(1, config.windowSize);

    SherpaOnnxVadModelConfig modelConfig;
    std::memset(&modelConfig, 0, sizeof(modelConfig));
    modelConfig.sample_rate = sampleRate_;
    modelConfig.num_threads = std::max(1, config.numThreads);
    modelConfig.provider = provider_.c_str();
    modelConfig.debug = config.debug ? 1 : 0;

    const float threshold =
        static_cast<float>(std::max(0.0, config.scoreThreshold));
    const float minSilence =
        static_cast<float>(std::max(0, config.minSilenceDurationMs)) / 1000.0f;
    const float minSpeech =
        static_cast<float>(std::max(0, config.minSpeechDurationMs)) / 1000.0f;
    const float maxSpeech =
        static_cast<float>(std::max(0, config.maxSpeechDurationMs)) / 1000.0f;

    if (modelType_ == "ten_vad") {
      modelConfig.ten_vad.model = modelPath_.c_str();
      modelConfig.ten_vad.threshold = threshold;
      modelConfig.ten_vad.min_silence_duration = minSilence;
      modelConfig.ten_vad.min_speech_duration = minSpeech;
      modelConfig.ten_vad.window_size = windowSize_;
      modelConfig.ten_vad.max_speech_duration = maxSpeech;
    } else {
      modelConfig.silero_vad.model = modelPath_.c_str();
      modelConfig.silero_vad.threshold = threshold;
      modelConfig.silero_vad.min_silence_duration = minSilence;
      modelConfig.silero_vad.min_speech_duration = minSpeech;
      modelConfig.silero_vad.window_size = windowSize_;
      modelConfig.silero_vad.max_speech_duration = maxSpeech;
    }

    const float bufferSec = std::max(1.0f, config.bufferSizeSeconds);
    handle_ = SherpaOnnxCreateVoiceActivityDetector(&modelConfig, bufferSec);
    if (handle_ == nullptr) {
      out.error = "SherpaOnnxCreateVoiceActivityDetector returned null";
      VAD_LOGE("init fail: %s", out.error.c_str());
      return out;
    }

    out.success = true;
    VAD_LOGI("init ok type=%s window=%d model=%s", modelType_.c_str(),
             windowSize_, modelPath_.c_str());
    return out;
  }

  void acceptWaveform(const float* samples, int32_t n) {
    if (handle_ == nullptr || samples == nullptr || n <= 0) return;
    SherpaOnnxVoiceActivityDetectorAcceptWaveform(handle_, samples, n);
  }

  void flush() {
    if (handle_ == nullptr) return;
    SherpaOnnxVoiceActivityDetectorFlush(handle_);
  }

  void reset() {
    if (handle_ == nullptr) return;
    SherpaOnnxVoiceActivityDetectorReset(handle_);
    SherpaOnnxVoiceActivityDetectorClear(handle_);
  }

  bool isSpeechDetected() const {
    if (handle_ == nullptr) return false;
    return SherpaOnnxVoiceActivityDetectorDetected(handle_) == 1;
  }

  std::vector<VadEngineSegment> popSegments() {
    std::vector<VadEngineSegment> out;
    if (handle_ == nullptr) return out;
    while (SherpaOnnxVoiceActivityDetectorEmpty(handle_) == 0) {
      const SherpaOnnxSpeechSegment* segment =
          SherpaOnnxVoiceActivityDetectorFront(handle_);
      if (segment != nullptr) {
        VadEngineSegment item;
        item.startSample = segment->start;
        item.endSample = segment->start + segment->n;
        item.durationMs = SamplesToMs(segment->n, sampleRate_);
        out.push_back(item);
        SherpaOnnxDestroySpeechSegment(segment);
      }
      SherpaOnnxVoiceActivityDetectorPop(handle_);
    }
    return out;
  }

  int32_t sampleRate() const { return sampleRate_; }
  int32_t windowSize() const { return windowSize_; }
  bool isInitialized() const { return handle_ != nullptr; }

  void release() {
    if (handle_ != nullptr) {
      SherpaOnnxDestroyVoiceActivityDetector(handle_);
      handle_ = nullptr;
      VAD_LOGI("released");
    }
  }

 private:
  const SherpaOnnxVoiceActivityDetector* handle_ = nullptr;
  std::string modelType_;
  std::string modelPath_;
  std::string provider_;
  int32_t sampleRate_ = 16000;
  int32_t windowSize_ = 512;
};

VadEngineWrapper::VadEngineWrapper() : pImpl(std::make_unique<Impl>()) {}
VadEngineWrapper::~VadEngineWrapper() = default;

VadEngineInitializeResult VadEngineWrapper::initialize(
    const VadEngineConfig& config) {
  return pImpl->initialize(config);
}

void VadEngineWrapper::acceptWaveform(const float* samples, int32_t n) {
  pImpl->acceptWaveform(samples, n);
}

void VadEngineWrapper::flush() { pImpl->flush(); }

void VadEngineWrapper::reset() { pImpl->reset(); }

bool VadEngineWrapper::isSpeechDetected() const {
  return pImpl->isSpeechDetected();
}

std::vector<VadEngineSegment> VadEngineWrapper::popSegments() {
  return pImpl->popSegments();
}

int32_t VadEngineWrapper::sampleRate() const { return pImpl->sampleRate(); }

int32_t VadEngineWrapper::windowSize() const { return pImpl->windowSize(); }

bool VadEngineWrapper::isInitialized() const {
  return pImpl->isInitialized();
}

void VadEngineWrapper::release() { pImpl->release(); }

}  // namespace sherpaonnx
