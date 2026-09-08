#ifndef SHERPA_ONNX_DIARIZATION_SPEAKER_TIMELINE_H
#define SHERPA_ONNX_DIARIZATION_SPEAKER_TIMELINE_H

#include "diarization-types.h"

#include <cstdint>
#include <utility>
#include <vector>

namespace sherpaonnx::diarization {

struct ChunkSpeakerSamples {
  ChunkSpeakerKey key;
  std::vector<SampleRange> ranges;
};

struct TimelineConfig {
  PyannoteMeta meta;
  float min_duration_on = 0.3f;
  float min_duration_off = 0.5f;
};

/** Per-frame speaker count after overlapping-window stitch (rounded). */
std::vector<int32_t> ComputeSpeakersPerFrame(
    const std::vector<Int8Matrix>& labels, const PyannoteMeta& meta);

/** Zero frames where multiple local speakers are active. */
std::vector<Int8Matrix> ExcludeOverlap(const std::vector<Int8Matrix>& labels);

/**
 * Collect (chunk, local_speaker) sample ranges from non-overlap labels.
 * Skips speakers with fewer than 10 active frames (upstream parity).
 */
std::vector<ChunkSpeakerSamples> GetChunkSpeakerSampleIndexes(
    const std::vector<Int8Matrix>& labels, const PyannoteMeta& meta);

/** Relabel local speaker columns to global cluster ids. */
std::vector<Int8Matrix> Relabel(
    const std::vector<Int8Matrix>& labels, int32_t num_clusters,
    const std::vector<ChunkSpeakerKey>& keys,
    const std::vector<int32_t>& cluster_labels);

/** Accumulate overlapping window votes into a global frame × cluster count. */
Int8Matrix ComputeSpeakerCount(const std::vector<Int8Matrix>& relabeled,
                               int32_t num_samples, const PyannoteMeta& meta);

/** Per-frame top-k by count, k = speakers_per_frame[frame]. */
Int8Matrix FinalizeLabels(const Int8Matrix& speaker_count,
                          const std::vector<int32_t>& speakers_per_frame);

/** Convert finalized frame labels to merged segments in seconds. */
std::vector<DiarizationSegment> ComputeResult(const Int8Matrix& final_labels,
                                              const TimelineConfig& config);

/**
 * Collapse speakers-per-frame into a single speech/silence column
 * (`1` when count >= 1). Used by `speech_pyannote_segmentation` (union-only).
 */
Int8Matrix SpeechUnionLabels(const std::vector<int32_t>& speakers_per_frame);

/**
 * One-chunk special case: trim trailing frames when audio ends mid-window.
 */
Int8Matrix TrimLabelsForNumSamples(const Int8Matrix& labels,
                                   int32_t num_samples,
                                   const PyannoteMeta& meta);

}  // namespace sherpaonnx::diarization

#endif  // SHERPA_ONNX_DIARIZATION_SPEAKER_TIMELINE_H
