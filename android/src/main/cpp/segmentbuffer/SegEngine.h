#pragma once

/**
 * Shared segmentation engine (S2).
 * This translation unit always provides the strong live hooks
 * (seg_engine_on_text_write, seg_engine_on_audio_append,
 * seg_engine_on_buffer_finalized, seg_engine_on_buffer_released) and the
 * control entry points (seg_engine_detach, seg_engine_flush,
 * seg_engine_peek_annotation). Audio/Text/Segment registries keep weak stubs
 * for host tests that do not link this file.
 * Define SHERPA_SEG_ENGINE_STUB_INFERENCE to compile without VAD / pyannote
 * (host tests that never call those evaluators).
 */

#include <cstdint>
#include <string>
#include <vector>

struct SegEnginePolicy {
  std::string evaluator;
  int maxLengthChars = 2000;
  bool sentenceBoundary = true;
  /** Non-empty replaces the built-in delimiter set (UTF-8 strings). */
  std::vector<std::string> sentenceBoundaryChars;
  int silenceThresholdMs = 500;
  double energyThresholdDb = -40.0;
  int minSegmentMs = 1000;
  int maxSegmentMs = 120000;
  int hangoverMs = 300;
  int checkpointIntervalMs = 0;
  std::string punctuationInstanceId;
  /** Absolute path to a VAD or pyannote `.onnx`. */
  std::string modelPath;
  /** `silero_vad` or `ten_vad`. */
  std::string modelType;
  double vadThreshold = 0.5;
  int vadMinSpeechMs = 250;
  int vadMinSilenceMs = 250;
  double windowShiftRatio = 0.1;
  double minDurationOn = 0.3;
  double minDurationOff = 0.5;
};

struct SegEngineInfoSnapshot {
  std::string engineId;
  std::string attachedBufferId;
  /** `text` or `speech`. */
  std::string domain;
  SegEnginePolicy policy;
  /** `active`, `detached`, or `released`. */
  std::string state;
  int totalSegmentsCommitted = 0;
  std::string lastSegmentId;
  std::string segmentBufferId;
};

/** One offline text slice. Offsets are UTF-16 code units (JS / Kotlin / NSString). */
struct SegOfflineTextSegment {
  std::string segmentId;
  int startOffset = 0;
  int endOffset = 0;
  std::string reason;
  std::string source;
  std::string text;
};

/**
 * Attach a live text or speech buffer.
 * Speech creates the live segment buffer via seg_create_live.
 * `out` may be null. On failure returns false and sets errorCode / error
 * (`CODE: message` when error is non-null).
 */
bool seg_engine_attach(const std::string &bufferId, const std::string &domain,
                       const SegEnginePolicy &policy, SegEngineInfoSnapshot *out,
                       std::string *errorCode, std::string *error);

bool seg_engine_get_info(const std::string &engineId, SegEngineInfoSnapshot *out,
                         std::string *errorCode, std::string *error);

/**
 * Offline segmentation.
 * Text: fills `textSegments` (UTF-16 offsets) and sets `outBufferId` to `bufferId`.
 * Speech: builds a SegOfflineEntry in g_seg_offline and sets `outBufferId` to that id.
 * `textSegments` may be null for speech. `outBufferId` is required for speech.
 */
bool seg_engine_segment_offline(const std::string &bufferId, const std::string &domain,
                                const SegEnginePolicy &policy,
                                std::vector<SegOfflineTextSegment> *textSegments,
                                std::string *outBufferId, int *segmentCount,
                                std::string *errorCode, std::string *error);

bool seg_engine_detach(const std::string &engineId, bool flushFinal, std::string *error);
bool seg_engine_flush(const std::string &engineId, std::string *error);
bool seg_engine_peek_annotation(const std::string &segmentId, std::string *reason,
                                std::string *source, int64_t *createdAtMs, int *segmentIndex);
void seg_engine_record_annotation(const std::string &segmentId, const std::string &reason,
                                  const std::string &source, int64_t createdAtMs, int segmentIndex);
void seg_engine_release_all();
