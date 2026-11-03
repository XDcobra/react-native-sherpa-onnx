#include "VadRuntime.h"

VadRuntime::VadRuntime(std::shared_ptr<sherpaonnx::VadEngineWrapper> engine)
  : engine_(std::move(engine)) {}

std::shared_ptr<VadRuntime> VadRuntime::Create(
  const VadRuntimeConfig &config,
  std::string *errorOut
) {
  sherpaonnx::VadEngineConfig cfg;
  cfg.modelType = config.modelType;
  cfg.modelPath = config.modelPath;
  cfg.sampleRate = config.sampleRate;
  cfg.numThreads = config.numThreads;
  cfg.provider = config.provider;
  cfg.debug = config.debug;
  cfg.scoreThreshold = config.scoreThreshold;
  cfg.minSilenceDurationMs = config.minSilenceDurationMs;
  cfg.minSpeechDurationMs = config.minSpeechDurationMs;
  cfg.maxSpeechDurationMs = config.maxSpeechDurationMs;
  cfg.windowSize = config.windowSize;
  cfg.bufferSizeSeconds = config.bufferSizeSeconds;

  auto engine = std::make_shared<sherpaonnx::VadEngineWrapper>();
  const auto init = engine->initialize(cfg);
  if (!init.success) {
    if (errorOut) {
      *errorOut = init.error.empty()
          ? "VadEngineWrapper::initialize failed"
          : init.error;
    }
    return nullptr;
  }
  return std::shared_ptr<VadRuntime>(new VadRuntime(std::move(engine)));
}

void VadRuntime::AcceptWaveform(const float *samples, int32_t n) const {
  if (!engine_ || samples == nullptr || n <= 0) return;
  engine_->acceptWaveform(samples, n);
}

void VadRuntime::Flush() const {
  if (!engine_) return;
  engine_->flush();
}

void VadRuntime::Reset() const {
  if (!engine_) return;
  engine_->reset();
}

bool VadRuntime::IsSpeechDetected() const {
  if (!engine_) return false;
  return engine_->isSpeechDetected();
}

std::vector<VadRuntimeSegment> VadRuntime::PopSegments() const {
  std::vector<VadRuntimeSegment> out;
  if (!engine_) return out;
  const auto segments = engine_->popSegments();
  out.reserve(segments.size());
  for (const auto &seg : segments) {
    VadRuntimeSegment item;
    item.startSample = seg.startSample;
    item.endSample = seg.endSample;
    item.durationMs = seg.durationMs;
    out.push_back(item);
  }
  return out;
}
