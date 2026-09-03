#include "sherpa-onnx-diarization-wrapper.h"

#include "diarization-session.h"

#include <utility>

namespace sherpaonnx {

class DiarizationWrapper::Impl {
 public:
  diarization::DiarizationSession session;
};

namespace {

DiarizationProcessResult ToProcessResult(
    const diarization::ProcessResult& in) {
  DiarizationProcessResult out;
  out.success = in.status.ok;
  out.error = in.status.message;
  out.errorCode = in.status.code;
  out.numSpeakers = in.num_speakers;
  out.sampleRate = in.sample_rate;
  out.speakersPerFrame = in.speakers_per_frame;
  out.segments.reserve(in.segments.size());
  for (const auto& s : in.segments) {
    DiarizationSegmentDto dto;
    dto.start = s.start;
    dto.end = s.end;
    dto.speaker = s.speaker;
    out.segments.push_back(dto);
  }
  return out;
}

}  // namespace

DiarizationWrapper::DiarizationWrapper() : pImpl(std::make_unique<Impl>()) {}
DiarizationWrapper::~DiarizationWrapper() { release(); }

void DiarizationWrapper::release() {
  if (pImpl) {
    pImpl->session.Release();
  }
}

bool DiarizationWrapper::isInitialized() const {
  return pImpl && pImpl->session.isInitialized();
}

int32_t DiarizationWrapper::getSampleRate() const {
  return pImpl ? pImpl->session.sampleRate() : 0;
}

void DiarizationWrapper::cancel() {
  if (pImpl) {
    pImpl->session.requestCancel();
  }
}

DiarizationInitializeResult DiarizationWrapper::initialize(
    const std::string& segmentationModel, const std::string& embeddingModel,
    float windowShiftRatio, int32_t numClusters, float threshold,
    float minDurationOn, float minDurationOff, int32_t numThreads,
    const std::optional<std::string>& provider, bool debug) {
  DiarizationInitializeResult result;
  if (!pImpl) {
    result.errorCode = diarization::kErrInternal;
    result.error = "wrapper impl missing";
    return result;
  }

  diarization::DiarizationInitConfig cfg;
  cfg.segmentation_model = segmentationModel;
  cfg.embedding_model = embeddingModel;
  cfg.window_shift_ratio = windowShiftRatio;
  cfg.num_clusters = numClusters;
  cfg.threshold = threshold;
  cfg.min_duration_on = minDurationOn;
  cfg.min_duration_off = minDurationOff;
  cfg.num_threads = numThreads;
  cfg.provider = provider.value_or("cpu");
  cfg.debug = debug;

  auto st = pImpl->session.Initialize(cfg);
  result.success = st.ok;
  result.error = st.message;
  result.errorCode = st.code;
  if (st.ok) {
    result.sampleRate = pImpl->session.sampleRate();
  }
  return result;
}

DiarizationProcessResult DiarizationWrapper::processMonoSamples(
    const std::vector<float>& monoSamples, int32_t sampleRate,
    bool includeOverlap, const DiarizationProgressFn& onProgress) {
  if (!pImpl || !pImpl->session.isInitialized()) {
    DiarizationProcessResult out;
    out.errorCode = diarization::kErrNotInitialized;
    out.error = "diarization not initialized";
    return out;
  }

  diarization::ProcessOptions opts;
  opts.include_overlap = includeOverlap;
  if (onProgress) {
    opts.on_progress = [&onProgress](const diarization::DiarizationProgress& p) {
      DiarizationProgressDto dto;
      dto.fraction = p.fraction;
      dto.phase = p.phase;
      dto.current = p.current;
      dto.total = p.total;
      onProgress(dto);
    };
  }

  return ToProcessResult(
      pImpl->session.Process(monoSamples, sampleRate, opts));
}

DiarizationProcessResult DiarizationWrapper::recluster(int32_t numClusters,
                                                       float threshold) {
  if (!pImpl || !pImpl->session.isInitialized()) {
    DiarizationProcessResult out;
    out.errorCode = diarization::kErrNotInitialized;
    out.error = "diarization not initialized";
    return out;
  }
  return ToProcessResult(pImpl->session.Recluster(numClusters, threshold));
}

std::vector<DiarizationClusterEmbeddingDto>
DiarizationWrapper::getClusterEmbeddings() const {
  std::vector<DiarizationClusterEmbeddingDto> out;
  if (!pImpl || !pImpl->session.isInitialized()) {
    return out;
  }
  auto centroids = pImpl->session.getClusterEmbeddings();
  out.reserve(centroids.size());
  for (auto& c : centroids) {
    DiarizationClusterEmbeddingDto dto;
    dto.speaker = c.speaker;
    dto.embedding = std::move(c.embedding);
    out.push_back(std::move(dto));
  }
  return out;
}

}  // namespace sherpaonnx
