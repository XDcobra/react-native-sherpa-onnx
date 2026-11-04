#include "SegEngine.h"

#include "AudioRegistry.h"
#include "PaLiveEntry.h"
#include "SegmentRegistry.h"
#include "TextRegistry.h"
#include "TxtUtf16.h"
#if !defined(SHERPA_SEG_ENGINE_STUB_INFERENCE)
#include "pyannote-segmentation-session.h"
#include "sherpa-onnx-vad-engine-wrapper.h"
#endif

#include <algorithm>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include <sys/stat.h>

#if defined(__ANDROID__)
#include <android/log.h>
#endif

#if defined(__APPLE__)
#include <TargetConditionals.h>
#endif

// iOS SherpaOnnx+Offline/OnlinePunctuation.mm own the strong symbols.
// Weak stubs keep Android and host links working until those TUs export them.
extern "C" __attribute__((weak)) bool sherpaonnx_punct_offline_add_punctuation_if_exists(
    const std::string &instanceId, const std::string &text, std::string *outText) {
  (void)instanceId;
  (void)text;
  (void)outText;
  return false;
}

extern "C" __attribute__((weak)) bool sherpaonnx_punct_online_add_punctuation_if_exists(
    const std::string &instanceId, const std::string &text, std::string *outText) {
  (void)instanceId;
  (void)text;
  (void)outText;
  return false;
}

extern "C" __attribute__((weak)) bool sherpaonnx_punct_offline_has_instance(
    const std::string &instanceId) {
  (void)instanceId;
  return false;
}

extern "C" __attribute__((weak)) bool sherpaonnx_punct_online_has_instance(
    const std::string &instanceId) {
  (void)instanceId;
  return false;
}

namespace {

enum class SegEngineDomain { Text, Speech };

enum class SegEngineState { Active, Detached, Released };

struct SegEngineAnnotation {
  std::string reason;
  std::string source;
  int64_t createdAtMs = 0;
  int segmentIndex = 0;
};

struct SegEngine {
  std::string engineId;
  SegEngineDomain domain = SegEngineDomain::Text;
  SegEngineState state = SegEngineState::Active;
  std::string attachedBufferId;
  SegEnginePolicy policy;
  std::string segmentBufferId;
  int totalSegmentsCommitted = 0;
  std::string lastSegmentId;
  std::vector<std::string> annotatedSegmentIds;

  int64_t segmentStartSample = 0;
  int64_t checkpointStartSample = 0;
  double silenceAccumulatedMs = 0.0;
#if !defined(SHERPA_SEG_ENGINE_STUB_INFERENCE)
  std::shared_ptr<sherpaonnx::VadEngineWrapper> vadRuntime;
#endif
  int vadFrameSize = 0;
  std::vector<float> pendingVadSamples;
};

std::unordered_map<std::string, std::shared_ptr<SegEngine>> g_seg_engine_by_id;
std::unordered_map<std::string, std::string> g_seg_engine_id_by_buffer;
std::unordered_map<std::string, SegEngineAnnotation> g_seg_engine_annotation_by_segment;
std::unordered_set<std::string> g_seg_engine_eval_guard;
std::mutex g_seg_engine_mutex;
std::condition_variable g_seg_engine_eval_cv;

void seg_engine_log(const char *fmt, ...) {
#if defined(__ANDROID__)
  va_list ap;
  va_start(ap, fmt);
  __android_log_vprint(ANDROID_LOG_DEBUG, "SherpaOnnx:segengine", fmt, ap);
  va_end(ap);
#else
  (void)fmt;
#endif
}

bool seg_fail(std::string *errorCode, std::string *error, const char *code,
              const std::string &message) {
  if (errorCode) *errorCode = code ? code : "";
  if (error) *error = std::string(code ? code : "") + ": " + message;
  seg_engine_log("fail code=%s msg=%s", code ? code : "", message.c_str());
  return false;
}

int64_t seg_now_ms() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

void seg_lowercase_ascii_inplace(std::string &s) {
  for (char &c : s) {
    const unsigned char uc = static_cast<unsigned char>(c);
    if (uc >= 'A' && uc <= 'Z') c = static_cast<char>(uc - 'A' + 'a');
  }
}

std::string seg_lowercase_ascii(const std::string &text) {
  std::string out = text;
  seg_lowercase_ascii_inplace(out);
  return out;
}

std::string seg_json_escape(const std::string &s) {
  std::string out;
  out.reserve(s.size() + 8);
  for (unsigned char c : s) {
    switch (c) {
      case '"':
        out += "\\\"";
        break;
      case '\\':
        out += "\\\\";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out.push_back(static_cast<char>(c));
        }
        break;
    }
  }
  return out;
}

std::string seg_format_double(double v) {
  char buf[64];
  std::snprintf(buf, sizeof(buf), "%.8g", v);
  return std::string(buf);
}

std::string seg_meta_json(const std::string &reason, int64_t createdAtMs,
                          const std::string *punctuationInstanceId) {
  std::string j = "{\"__segmentReason\":\"";
  j += seg_json_escape(reason);
  j += "\",\"__segmentSource\":\"segmentation_engine\",\"__segmentCreatedAtMs\":";
  j += std::to_string(createdAtMs);
  if (punctuationInstanceId != nullptr) {
    j += ",\"punctuationInstanceId\":\"";
    j += seg_json_escape(*punctuationInstanceId);
    j += "\"";
  }
  j += "}";
  return j;
}

std::string seg_vad_payload_json(bool withScore, double score) {
  std::string j = "{\"source\":\"vad\",\"engine\":\"vad\",\"decision\":\"model\"";
  if (withScore) {
    j += ",\"score\":";
    j += seg_format_double(score);
  }
  j += "}";
  return j;
}

const char *seg_pyannote_payload_json() { return "{\"source\":\"pyannote\"}"; }

size_t seg_utf8_decode(const std::string &s, size_t i, uint32_t *cp) {
  if (i >= s.size() || cp == nullptr) return 0;
  const auto *p = reinterpret_cast<const unsigned char *>(s.data());
  const unsigned char c0 = p[i];
  if (c0 < 0x80) {
    *cp = c0;
    return 1;
  }
  if ((c0 >> 5) == 0x6 && i + 1 < s.size() && (p[i + 1] & 0xC0) == 0x80) {
    *cp = (static_cast<uint32_t>(c0 & 0x1F) << 6) | (p[i + 1] & 0x3F);
    return 2;
  }
  if ((c0 >> 4) == 0xE && i + 2 < s.size() && (p[i + 1] & 0xC0) == 0x80 &&
      (p[i + 2] & 0xC0) == 0x80) {
    *cp = (static_cast<uint32_t>(c0 & 0x0F) << 12) | (static_cast<uint32_t>(p[i + 1] & 0x3F) << 6) |
          (p[i + 2] & 0x3F);
    return 3;
  }
  if ((c0 >> 3) == 0x1E && i + 3 < s.size() && (p[i + 1] & 0xC0) == 0x80 &&
      (p[i + 2] & 0xC0) == 0x80 && (p[i + 3] & 0xC0) == 0x80) {
    *cp = (static_cast<uint32_t>(c0 & 0x07) << 18) | (static_cast<uint32_t>(p[i + 1] & 0x3F) << 12) |
          (static_cast<uint32_t>(p[i + 2] & 0x3F) << 6) | (p[i + 3] & 0x3F);
    return 4;
  }
  *cp = c0;
  return 1;
}

bool seg_is_default_sentence_boundary(uint32_t cp) {
  switch (cp) {
    case static_cast<uint32_t>('.'):
    case static_cast<uint32_t>('!'):
    case static_cast<uint32_t>('?'):
    case static_cast<uint32_t>('\n'):
    case static_cast<uint32_t>(';'):
    case static_cast<uint32_t>(':'):
    case 0x3002:  // 。
    case 0xFF01:  // ！
    case 0xFF1F:  // ？
    case 0xFF61:  // ｡
    case 0x061F:  // ؟
    case 0x0964:  // ।
    case 0x0965:  // ॥
      return true;
    default:
      return false;
  }
}

size_t seg_utf8_sentence_boundary_prefix_len_first(const std::string &remaining) {
  size_t i = 0;
  while (i < remaining.size()) {
    uint32_t cp = 0;
    const size_t n = seg_utf8_decode(remaining, i, &cp);
    if (n == 0) return std::string::npos;
    i += n;
    if (seg_is_default_sentence_boundary(cp)) return i;
  }
  return std::string::npos;
}

[[maybe_unused]] size_t seg_utf8_sentence_boundary_prefix_len_last(const std::string &s) {
  size_t i = 0;
  size_t last = std::string::npos;
  while (i < s.size()) {
    uint32_t cp = 0;
    const size_t n = seg_utf8_decode(s, i, &cp);
    if (n == 0) break;
    i += n;
    if (seg_is_default_sentence_boundary(cp)) last = i;
  }
  return last;
}

bool seg_has_suffix(const std::string &prefix, const std::string &delim) {
  return !delim.empty() && delim.size() <= prefix.size() &&
         prefix.compare(prefix.size() - delim.size(), delim.size(), delim) == 0;
}

size_t seg_utf8_custom_delimiter_prefix_len_first(const std::string &remaining,
                                                 const std::vector<std::string> &delims) {
  if (remaining.empty() || delims.empty()) return std::string::npos;
  size_t i = 0;
  while (i < remaining.size()) {
    uint32_t cp = 0;
    const size_t n = seg_utf8_decode(remaining, i, &cp);
    if (n == 0) return std::string::npos;
    i += n;
    (void)cp;
    const std::string prefix = remaining.substr(0, i);
    for (const auto &d : delims) {
      if (seg_has_suffix(prefix, d)) return i;
    }
  }
  return std::string::npos;
}

[[maybe_unused]] size_t seg_utf8_custom_delimiter_prefix_len_last(
    const std::string &s, const std::vector<std::string> &delims) {
  if (s.empty() || delims.empty()) return std::string::npos;
  size_t i = 0;
  size_t last = std::string::npos;
  while (i < s.size()) {
    uint32_t cp = 0;
    const size_t n = seg_utf8_decode(s, i, &cp);
    if (n == 0) break;
    i += n;
    (void)cp;
    const std::string prefix = s.substr(0, i);
    for (const auto &d : delims) {
      if (seg_has_suffix(prefix, d)) last = i;
    }
  }
  return last;
}

bool seg_validate_boundary_chars(const std::vector<std::string> &chars, std::string *errorCode,
                                 std::string *error) {
  if (chars.size() > 128) {
    return seg_fail(errorCode, error, "POLICY_INVALID",
                    "sentenceBoundaryChars must have at most 128 entries");
  }
  for (const auto &s : chars) {
    if (s.empty()) continue;
    if (txt_utf16_length(s) > 64) {
      return seg_fail(errorCode, error, "POLICY_INVALID",
                      "sentenceBoundaryChars entries must be at most 64 characters");
    }
  }
  return true;
}

void seg_normalize_policy(SegEnginePolicy &p, bool textDomain) {
  seg_lowercase_ascii_inplace(p.evaluator);
  if (p.evaluator.empty()) {
    p.evaluator = textDomain ? "text_synthetic_auto" : "speech_energy_silence";
  }
  if (p.maxLengthChars < 1) p.maxLengthChars = 1;
  if (p.silenceThresholdMs < 50) p.silenceThresholdMs = 50;
  if (p.minSegmentMs < 100) p.minSegmentMs = 100;
  if (p.maxSegmentMs < p.minSegmentMs) p.maxSegmentMs = p.minSegmentMs;
  if (p.hangoverMs < 0) p.hangoverMs = 0;
  if (p.checkpointIntervalMs < 0) p.checkpointIntervalMs = 0;
  if (p.vadMinSpeechMs < 1) p.vadMinSpeechMs = 1;
  if (p.vadMinSilenceMs < 1) p.vadMinSilenceMs = 1;
  if (!(p.windowShiftRatio > 0.0 && p.windowShiftRatio <= 1.0)) p.windowShiftRatio = 0.1;
  if (p.minDurationOn < 0.0) p.minDurationOn = 0.0;
  if (p.minDurationOff < 0.0) p.minDurationOff = 0.0;
  std::vector<std::string> kept;
  kept.reserve(p.sentenceBoundaryChars.size());
  for (const auto &d : p.sentenceBoundaryChars) {
    if (!d.empty()) kept.push_back(d);
  }
  p.sentenceBoundaryChars.swap(kept);
}

bool seg_parse_domain(const std::string &raw, SegEngineDomain *out, std::string *errorCode,
                      std::string *error) {
  std::string d = raw;
  seg_lowercase_ascii_inplace(d);
  if (d == "text") {
    if (out) *out = SegEngineDomain::Text;
    return true;
  }
  if (d == "speech") {
    if (out) *out = SegEngineDomain::Speech;
    return true;
  }
  return seg_fail(errorCode, error, "POLICY_INVALID",
                  "Unsupported segmentation domain: " + raw);
}

bool seg_path_is_regular_file(const std::string &path) {
  if (path.empty()) return false;
  struct stat st;
  if (::stat(path.c_str(), &st) != 0) return false;
  return S_ISREG(st.st_mode);
}

bool seg_punctuation_instance_exists(const std::string &instanceId) {
  if (instanceId.empty()) return false;
  return sherpaonnx_punct_online_has_instance(instanceId) ||
         sherpaonnx_punct_offline_has_instance(instanceId);
}

std::string seg_add_punctuation_or_throw(const std::string &instanceId, const std::string &text) {
  std::string out;
  if (sherpaonnx_punct_online_add_punctuation_if_exists(instanceId, text, &out)) return out;
  if (sherpaonnx_punct_offline_add_punctuation_if_exists(instanceId, text, &out)) return out;
  throw std::runtime_error("POLICY_PUNCTUATION_INSTANCE_NOT_FOUND: Punctuation instance not found: " +
                           instanceId);
}

size_t seg_first_delimiter_end_exclusive(const std::string &text, const SegEnginePolicy &policy) {
  if (policy.sentenceBoundaryChars.empty()) {
    return seg_utf8_sentence_boundary_prefix_len_first(text);
  }
  return seg_utf8_custom_delimiter_prefix_len_first(text, policy.sentenceBoundaryChars);
}

[[maybe_unused]] int seg_assisted_commit_length(const std::string &partial,
                                                const std::string &instanceId,
                                                const SegEnginePolicy &policy) {
  if (partial.empty()) return 0;
  const std::string normalized = seg_lowercase_ascii(partial);
  const std::string punctuated = seg_add_punctuation_or_throw(instanceId, normalized);
  const size_t endInPunctuated = seg_first_delimiter_end_exclusive(punctuated, policy);
  if (endInPunctuated == std::string::npos || endInPunctuated == 0) return 0;
  if (endInPunctuated <= normalized.size()) {
    return static_cast<int>(std::min(partial.size(), endInPunctuated));
  }
  int n = static_cast<int>(std::min(normalized.size(), endInPunctuated));
  while (n > 0) {
    const std::string prefixPunctuated =
        seg_add_punctuation_or_throw(instanceId, normalized.substr(0, static_cast<size_t>(n)));
    const size_t prefixEnd = seg_first_delimiter_end_exclusive(prefixPunctuated, policy);
    if (prefixEnd != std::string::npos && prefixEnd == prefixPunctuated.size()) {
      return static_cast<int>(std::min(partial.size(), static_cast<size_t>(n)));
    }
    --n;
  }
  return 0;
}

std::string seg_reason_from_eval(const std::string &eval, bool silenceCommit) {
  if (eval == "speech_vad_model") return "vad_boundary";
  if (eval == "speech_pyannote_segmentation") return "pyannote_boundary";
  return silenceCommit ? "energy_silence" : "length_limit";
}

double seg_rms_db(const float *samples, size_t count) {
  if (samples == nullptr || count == 0) return -120.0;
  double sum = 0.0;
  for (size_t i = 0; i < count; ++i) {
    const double v = samples[i];
    sum += v * v;
  }
  const double rms = std::sqrt(sum / static_cast<double>(count));
  if (rms <= 1e-9) return -120.0;
  return 20.0 * std::log10(rms);
}

void seg_record_annotation(const std::string &segmentId, const std::string &reason,
                           int segmentIndex) {
  std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
  g_seg_engine_annotation_by_segment[segmentId] = SegEngineAnnotation{
      reason, "segmentation_engine", seg_now_ms(), segmentIndex};
}

SegEngineInfoSnapshot seg_engine_snapshot(const SegEngine &engine) {
  SegEngineInfoSnapshot out;
  out.engineId = engine.engineId;
  out.attachedBufferId = engine.attachedBufferId;
  out.domain = engine.domain == SegEngineDomain::Text ? "text" : "speech";
  out.policy = engine.policy;
  if (engine.state == SegEngineState::Active) out.state = "active";
  else if (engine.state == SegEngineState::Released) out.state = "released";
  else out.state = "detached";
  out.totalSegmentsCommitted = engine.totalSegmentsCommitted;
  out.lastSegmentId = engine.lastSegmentId;
  out.segmentBufferId = engine.segmentBufferId;
  return out;
}

bool seg_init_vad_runtime(const std::shared_ptr<SegEngine> &engine, int sampleRate,
                          std::string *errorOut) {
  if (!engine) {
    if (errorOut) *errorOut = "Segmentation engine is null";
    return false;
  }
  const std::string &onnxPath = engine->policy.modelPath;
  if (onnxPath.empty() || !seg_path_is_regular_file(onnxPath)) {
    if (errorOut) {
      *errorOut = "speech_vad_model modelPath must be an existing .onnx file: " + onnxPath;
    }
    return false;
  }
  const std::string &mt = engine->policy.modelType;
  if (mt != "silero_vad" && mt != "ten_vad") {
    if (errorOut) *errorOut = "speech_vad_model requires modelType silero_vad or ten_vad";
    return false;
  }

#if defined(SHERPA_SEG_ENGINE_STUB_INFERENCE)
  if (errorOut) *errorOut = "speech_vad_model runtime is unavailable";
  return false;
#else
  sherpaonnx::VadEngineConfig cfg;
  cfg.modelType = mt;
  cfg.modelPath = onnxPath;
  cfg.sampleRate = std::max(1, sampleRate);
  cfg.numThreads = 1;
  cfg.provider = "cpu";
  cfg.debug = false;
  cfg.scoreThreshold = engine->policy.vadThreshold;
  cfg.minSpeechDurationMs = std::max(1, engine->policy.vadMinSpeechMs);
  cfg.minSilenceDurationMs = std::max(1, engine->policy.vadMinSilenceMs);
  cfg.maxSpeechDurationMs = std::max(cfg.minSpeechDurationMs, engine->policy.maxSegmentMs);
  cfg.windowSize = cfg.modelType == "ten_vad" ? 256 : 512;

  auto runtime = std::make_shared<sherpaonnx::VadEngineWrapper>();
  const auto init = runtime->initialize(cfg);
  if (!init.success) {
    if (errorOut) {
      *errorOut = "speech_vad_model failed to initialize runtime: " +
                  (init.error.empty() ? std::string("unknown error") : init.error);
    }
    return false;
  }
  engine->vadRuntime = std::move(runtime);
  engine->vadFrameSize = std::max(1, cfg.windowSize);
  engine->pendingVadSamples.clear();
  return true;
#endif
}

#if !defined(SHERPA_SEG_ENGINE_STUB_INFERENCE)
std::string seg_status_message(const sherpaonnx::speaker_embedding::Status &status,
                               const char *fallback) {
  if (!status.message.empty()) return status.message;
  if (!status.code.empty()) return status.code;
  return fallback ? fallback : "unknown error";
}
#endif

[[maybe_unused]] bool seg_append_speech_segment(const std::shared_ptr<SegEngine> &engine,
                                                int64_t endSampleExclusive,
                                                const std::string &reason, double score) {
  if (!engine || engine->segmentBufferId.empty()) return false;
  if (endSampleExclusive <= engine->segmentStartSample) return false;
  auto live = pa_get_live_entry(engine->attachedBufferId);
  if (!live || live->sampleRate <= 0) return false;

  const int64_t lengthSamples = endSampleExclusive - engine->segmentStartSample;
  const int durationMs =
      static_cast<int>((static_cast<double>(lengthSamples) * 1000.0) / live->sampleRate);
  if (durationMs <= 0) return false;

  const std::string payloadJson = seg_vad_payload_json(true, score);
  std::string segmentId;
  int segmentIndex = 0;
  std::string err;
  const bool ok = seg_live_append_segment(
      engine->segmentBufferId, "speech", engine->attachedBufferId,
      static_cast<int>(engine->segmentStartSample), static_cast<int>(endSampleExclusive),
      live->sampleRate, durationMs, false, 0.0, payloadJson, &segmentId, &segmentIndex, &err,
      false);
  if (!ok) return false;

  {
    std::lock_guard<std::mutex> annLock(g_seg_engine_mutex);
    g_seg_engine_annotation_by_segment[segmentId] = SegEngineAnnotation{
        reason, "segmentation_engine", seg_now_ms(), segmentIndex};
  }
  seg_live_emit_appended(engine->segmentBufferId, segmentId, segmentIndex);
  engine->totalSegmentsCommitted += 1;
  engine->lastSegmentId = segmentId;
  engine->segmentStartSample = endSampleExclusive;
  engine->checkpointStartSample = endSampleExclusive;
  engine->silenceAccumulatedMs = 0.0;
  seg_engine_log("commit speech id=%s reason=%s end=%lld", segmentId.c_str(), reason.c_str(),
                 static_cast<long long>(endSampleExclusive));
  return true;
}

[[maybe_unused]] bool seg_append_speech_segment_range(const std::shared_ptr<SegEngine> &engine,
                                                      int64_t startSample, int64_t endSampleExclusive,
                                                      const std::string &reason) {
  if (!engine || engine->segmentBufferId.empty()) return false;
  if (endSampleExclusive <= startSample) return false;
  auto live = pa_get_live_entry(engine->attachedBufferId);
  if (!live || live->sampleRate <= 0) return false;

  const int durationMs = static_cast<int>(
      ((static_cast<double>(endSampleExclusive - startSample)) * 1000.0) / live->sampleRate);
  if (durationMs <= 0) return false;

  const std::string payloadJson = seg_vad_payload_json(false, 0.0);
  std::string segmentId;
  int segmentIndex = 0;
  std::string err;
  const bool ok = seg_live_append_segment(
      engine->segmentBufferId, "speech", engine->attachedBufferId, static_cast<int>(startSample),
      static_cast<int>(endSampleExclusive), live->sampleRate, durationMs, false, 0.0, payloadJson,
      &segmentId, &segmentIndex, &err, false);
  if (!ok) return false;

  {
    std::lock_guard<std::mutex> annLock(g_seg_engine_mutex);
    g_seg_engine_annotation_by_segment[segmentId] = SegEngineAnnotation{
        reason, "segmentation_engine", seg_now_ms(), segmentIndex};
  }
  seg_live_emit_appended(engine->segmentBufferId, segmentId, segmentIndex);
  engine->totalSegmentsCommitted += 1;
  engine->lastSegmentId = segmentId;
  seg_engine_log("commit vad id=%s reason=%s start=%lld end=%lld", segmentId.c_str(),
                 reason.c_str(), static_cast<long long>(startSample),
                 static_cast<long long>(endSampleExclusive));
  return true;
}

[[maybe_unused]] void seg_append_runtime_vad_segments(const std::shared_ptr<SegEngine> &engine,
                                                     const std::string &reason) {
#if !defined(SHERPA_SEG_ENGINE_STUB_INFERENCE)
  if (!engine || !engine->vadRuntime) return;
  const auto segments = engine->vadRuntime->popSegments();
  for (const auto &segment : segments) {
    seg_append_speech_segment_range(engine, segment.startSample, segment.endSample, reason);
  }
#else
  (void)engine;
  (void)reason;
#endif
}

[[maybe_unused]] void seg_engine_evaluate_text(const std::shared_ptr<SegEngine> &engine) {
  if (!engine || engine->state != SegEngineState::Active) return;
  auto entry = txt_get_live_entry(engine->attachedBufferId);
  if (!entry) return;

  while (true) {
    const std::string partial = entry->snapshotText();
    if (partial.empty()) break;

    int commitLength = 0;
    std::string reason = "policy_checkpoint";

    if (engine->policy.evaluator == "text_punctuation_assisted") {
      if (engine->policy.punctuationInstanceId.empty()) {
        throw std::runtime_error(
            "POLICY_PUNCTUATION_INSTANCE_NOT_FOUND: text_punctuation_assisted requires "
            "punctuationInstanceId");
      }
      if (engine->policy.sentenceBoundary) {
        commitLength = seg_assisted_commit_length(partial, engine->policy.punctuationInstanceId,
                                                   engine->policy);
        if (commitLength > 0) reason = "punctuation";
      }
    } else if (engine->policy.sentenceBoundary) {
      const size_t prefixLen = seg_first_delimiter_end_exclusive(partial, engine->policy);
      if (prefixLen != std::string::npos && prefixLen > 0) {
        commitLength = static_cast<int>(std::min(partial.size(), prefixLen));
        reason = "punctuation";
      }
    }

    if (commitLength <= 0 && static_cast<int>(partial.size()) >= engine->policy.maxLengthChars) {
      const int maxLen = std::max(1, engine->policy.maxLengthChars);
      const std::string prefix = partial.substr(0, static_cast<size_t>(maxLen));
      const size_t space = prefix.find_last_of(' ');
      commitLength = static_cast<int>(space == std::string::npos ? maxLen : space + 1);
      reason = "length_limit";
    }
    if (commitLength <= 0) break;

    const std::string committed = partial.substr(0, static_cast<size_t>(commitLength));
    const std::string remainder = partial.substr(static_cast<size_t>(commitLength));
    if (committed.empty()) break;

    const std::string meta =
        seg_meta_json(reason, seg_now_ms(), &engine->policy.punctuationInstanceId);
    const int segmentIndex = entry->commitSegment(committed, {}, {}, "stt_stream", meta);
    entry->writePartial(remainder);
    engine->totalSegmentsCommitted += 1;
    engine->lastSegmentId =
        "txtseg_" + engine->attachedBufferId + "_" + std::to_string(segmentIndex);
    seg_engine_log("commit text id=%s reason=%s bytes=%d", engine->lastSegmentId.c_str(),
                   reason.c_str(), commitLength);
  }
}

[[maybe_unused]] void seg_engine_flush_text(const std::shared_ptr<SegEngine> &engine) {
  if (!engine || engine->state != SegEngineState::Active) return;
  auto entry = txt_get_live_entry(engine->attachedBufferId);
  if (!entry) return;
  const std::string partial = entry->snapshotText();
  if (partial.empty()) return;
  const std::string meta = seg_meta_json("finalize", seg_now_ms(), nullptr);
  const int segmentIndex = entry->commitSegment(partial, {}, {}, "stt_stream", meta);
  entry->writePartial("");
  engine->totalSegmentsCommitted += 1;
  engine->lastSegmentId =
      "txtseg_" + engine->attachedBufferId + "_" + std::to_string(segmentIndex);
  seg_engine_log("flush text id=%s", engine->lastSegmentId.c_str());
}

[[maybe_unused]] void seg_engine_evaluate_audio(const std::shared_ptr<SegEngine> &engine,
                                                const float *samples, size_t count, int sampleRate,
                                                int64_t totalSamplesWritten) {
  if (!engine || engine->state != SegEngineState::Active) return;
  if (samples == nullptr || count == 0 || sampleRate <= 0) return;

  if (engine->policy.evaluator == "continuous_frames") {
    if (engine->policy.checkpointIntervalMs <= 0) return;
    const double checkpointMs =
        (static_cast<double>(std::max<int64_t>(0, totalSamplesWritten - engine->checkpointStartSample)) *
         1000.0) /
        sampleRate;
    if (checkpointMs >= engine->policy.checkpointIntervalMs) {
      const double db = seg_rms_db(samples, count);
      seg_append_speech_segment(engine, totalSamplesWritten, "policy_checkpoint", db);
    }
    return;
  }

  if (engine->policy.evaluator == "speech_vad_model") {
#if !defined(SHERPA_SEG_ENGINE_STUB_INFERENCE)
    if (!engine->vadRuntime || engine->vadFrameSize <= 0) return;
    const int frameSize = std::max(1, engine->vadFrameSize);
    engine->pendingVadSamples.insert(engine->pendingVadSamples.end(), samples, samples + count);
    while (static_cast<int>(engine->pendingVadSamples.size()) >= frameSize) {
      engine->vadRuntime->acceptWaveform(engine->pendingVadSamples.data(), frameSize);
      seg_append_runtime_vad_segments(engine, "vad_boundary");
      engine->pendingVadSamples.erase(engine->pendingVadSamples.begin(),
                                       engine->pendingVadSamples.begin() + frameSize);
    }
#endif
    return;
  }

  const double chunkDurationMs = (static_cast<double>(count) * 1000.0) / sampleRate;
  const double db = seg_rms_db(samples, count);
  if (db < engine->policy.energyThresholdDb) engine->silenceAccumulatedMs += chunkDurationMs;
  else engine->silenceAccumulatedMs = 0.0;

  const double segmentDurationMs =
      (static_cast<double>(std::max<int64_t>(0, totalSamplesWritten - engine->segmentStartSample)) *
       1000.0) /
      sampleRate;
  const bool silenceCommit =
      engine->silenceAccumulatedMs >=
          (engine->policy.silenceThresholdMs + engine->policy.hangoverMs) &&
      segmentDurationMs >= engine->policy.minSegmentMs;
  const bool lengthCommit = segmentDurationMs >= engine->policy.maxSegmentMs;
  if (silenceCommit || lengthCommit) {
    const std::string reason = seg_reason_from_eval(engine->policy.evaluator, silenceCommit);
    seg_append_speech_segment(engine, totalSamplesWritten, reason, db);
  }
}

[[maybe_unused]] void seg_engine_flush_audio(const std::shared_ptr<SegEngine> &engine) {
  if (!engine || engine->state != SegEngineState::Active) return;
  if (engine->policy.evaluator == "speech_vad_model") {
#if !defined(SHERPA_SEG_ENGINE_STUB_INFERENCE)
    if (!engine->vadRuntime || engine->vadFrameSize <= 0) return;
    const int frameSize = std::max(1, engine->vadFrameSize);
    if (!engine->pendingVadSamples.empty()) {
      std::vector<float> tail(static_cast<size_t>(frameSize), 0.0f);
      std::copy(engine->pendingVadSamples.begin(), engine->pendingVadSamples.end(), tail.begin());
      engine->vadRuntime->acceptWaveform(tail.data(), frameSize);
      engine->pendingVadSamples.clear();
      seg_append_runtime_vad_segments(engine, "vad_boundary");
    }
    engine->vadRuntime->flush();
    seg_append_runtime_vad_segments(engine, "finalize");
#endif
    return;
  }
  auto live = pa_get_live_entry(engine->attachedBufferId);
  if (!live) return;
  if (live->totalSamplesWritten > engine->segmentStartSample) {
    seg_append_speech_segment(engine, live->totalSamplesWritten, "finalize", 0.0);
  }
}

struct EvalGuard {
  std::string id;
  explicit EvalGuard(std::string bufferId) : id(std::move(bufferId)) {}
  ~EvalGuard() {
    {
      std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
      g_seg_engine_eval_guard.erase(id);
    }
    g_seg_engine_eval_cv.notify_all();
  }
  EvalGuard(const EvalGuard &) = delete;
  EvalGuard &operator=(const EvalGuard &) = delete;
};

bool seg_validate_text_evaluator(const SegEnginePolicy &policy, bool requireInstance,
                                 std::string *errorCode, std::string *error) {
  if (!(policy.evaluator == "text_synthetic_auto" ||
        policy.evaluator == "text_punctuation_assisted")) {
    return seg_fail(errorCode, error, "POLICY_INVALID",
                    "Policy evaluator '" + policy.evaluator + "' is invalid for text domain");
  }
  if (policy.evaluator == "text_punctuation_assisted") {
    if (policy.punctuationInstanceId.empty()) {
      return seg_fail(errorCode, error, "POLICY_PUNCTUATION_INSTANCE_NOT_FOUND",
                      "text_punctuation_assisted requires policy.punctuationInstanceId");
    }
    if (requireInstance && !seg_punctuation_instance_exists(policy.punctuationInstanceId)) {
      return seg_fail(errorCode, error, "POLICY_PUNCTUATION_INSTANCE_NOT_FOUND",
                      "Punctuation instance not found for segmentation policy: " +
                          policy.punctuationInstanceId);
    }
  }
  return true;
}

bool seg_validate_speech_evaluator_live(const SegEnginePolicy &policy, std::string *errorCode,
                                        std::string *error) {
  if (!(policy.evaluator == "speech_energy_silence" || policy.evaluator == "speech_vad_model" ||
        policy.evaluator == "speech_pyannote_segmentation" ||
        policy.evaluator == "continuous_frames")) {
    return seg_fail(errorCode, error, "POLICY_INVALID",
                    "Policy evaluator '" + policy.evaluator + "' is invalid for speech domain");
  }
  if (policy.evaluator == "speech_pyannote_segmentation") {
    return seg_fail(errorCode, error, "POLICY_INVALID",
                    "Policy evaluator 'speech_pyannote_segmentation' is offline-only and invalid "
                    "for live attach");
  }
  return true;
}

bool seg_segment_offline_text(const std::string &bufferId, const SegEnginePolicy &policy,
                              std::vector<SegOfflineTextSegment> *textSegments,
                              std::string *outBufferId, int *segmentCount, std::string *errorCode,
                              std::string *error) {
  if (!seg_validate_boundary_chars(policy.sentenceBoundaryChars, errorCode, error)) return false;
  TxtOfflineTextView textView;
  std::string viewCode;
  std::string viewMsg;
  if (!txt_acquire_offline_text_view(bufferId, /*allowEmpty=*/false, &textView, &viewCode, &viewMsg)) {
    return seg_fail(errorCode, error, "BUFFER_STATE_INVALID",
                    viewMsg.empty() ? "Offline text buffer not found" : viewMsg);
  }
  // Hold entry for the whole run; local string needed for UTF-16 slicing / punct mutation.
  std::string text;
  SegEnginePolicy p = policy;
  seg_normalize_policy(p, true);
  if (!seg_validate_text_evaluator(p, false, errorCode, error)) return false;
  if (p.evaluator == "text_punctuation_assisted") {
    try {
      text = seg_add_punctuation_or_throw(p.punctuationInstanceId,
                                          std::string(textView.data, textView.bytes));
    } catch (const std::exception &e) {
      return seg_fail(errorCode, error, "POLICY_PUNCTUATION_INSTANCE_NOT_FOUND", e.what());
    }
  } else {
    text.assign(textView.data, textView.bytes);
  }

  std::vector<SegOfflineTextSegment> segments;
  int index = 0;
  const int totalLen = txt_utf16_length(text);
  const int maxLen = std::max(1, p.maxLengthChars);
  while (index < totalLen) {
    const int remainingLen = totalLen - index;
    const std::string remaining = txt_utf16_slice(text, index, remainingLen);
    int split = 0;
    bool foundBoundary = false;
    if (p.sentenceBoundary) {
      const size_t byteLen = seg_first_delimiter_end_exclusive(remaining, p);
      if (byteLen != std::string::npos && byteLen > 0 && byteLen <= remaining.size()) {
        split = txt_utf16_length(remaining.substr(0, byteLen));
        foundBoundary = split > 0;
      }
    }
    if (split <= 0) {
      split = std::min(maxLen, remainingLen);
      if (split < remainingLen) {
        const std::string prefix = txt_utf16_slice(remaining, 0, split);
        const size_t space = prefix.rfind(' ');
        if (space != std::string::npos && space > 0) {
          split = txt_utf16_length(prefix.substr(0, space + 1));
        }
      }
    }
    if (split <= 0) break;
    if (split > remainingLen) split = remainingLen;
    const std::string chunk = txt_utf16_slice(remaining, 0, split);
    const int end = index + split;
    const bool isFinalChunk = split >= remainingLen;
    SegOfflineTextSegment rec;
    rec.segmentId = "txtseg_" + bufferId + "_" + std::to_string(segments.size());
    rec.startOffset = index;
    rec.endOffset = end;
    rec.reason = isFinalChunk ? "finalize" : (foundBoundary ? "punctuation" : "length_limit");
    rec.source = "segmentation_engine";
    rec.text = chunk;
    segments.push_back(std::move(rec));
    index = end;
  }

  if (segmentCount) *segmentCount = static_cast<int>(segments.size());
  if (outBufferId) *outBufferId = bufferId;
  if (textSegments) *textSegments = std::move(segments);
  seg_engine_log("offline text id=%s count=%d evaluator=%s", bufferId.c_str(),
                 segmentCount ? *segmentCount : 0, p.evaluator.c_str());
  return true;
}

bool seg_segment_offline_speech(const std::string &bufferId, const SegEnginePolicy &policyIn,
                                std::string *outBufferId, int *segmentCount, std::string *errorCode,
                                std::string *error) {
  if (outBufferId == nullptr) {
    return seg_fail(errorCode, error, "SEGMENT_INTERNAL_ERROR",
                    "segment buffer id output is null");
  }
  int sampleRate = 0;
  int totalSamples = 0;
  std::string metaErrCode;
  std::string metaErrMessage;
  if (!pa_get_offline_metadata(bufferId, &sampleRate, &totalSamples, &metaErrCode,
                               &metaErrMessage)) {
    (void)metaErrCode;
    (void)metaErrMessage;
    return seg_fail(errorCode, error, "BUFFER_STATE_INVALID",
                    "Offline audio buffer not found: " + bufferId);
  }
  (void)metaErrCode;
  (void)metaErrMessage;
  if (sampleRate <= 0) {
    return seg_fail(errorCode, error, "BUFFER_STATE_INVALID",
                    "Offline audio buffer has invalid sample rate: " + bufferId);
  }
  if (totalSamples < 0) totalSamples = 0;

  SegEnginePolicy p = policyIn;
  seg_normalize_policy(p, false);
  if (!(p.evaluator == "speech_energy_silence" || p.evaluator == "speech_vad_model" ||
        p.evaluator == "speech_pyannote_segmentation" || p.evaluator == "continuous_frames")) {
    return seg_fail(errorCode, error, "POLICY_INVALID",
                    "Policy evaluator '" + p.evaluator + "' is invalid for speech domain");
  }
  if (p.evaluator == "continuous_frames") {
    return seg_fail(errorCode, error, "POLICY_INVALID_FOR_OFFLINE",
                    "Policy evaluator 'continuous_frames' is streaming-only and invalid for "
                    "offline segmentation");
  }

  std::vector<SegRecord> records;
  if (p.evaluator == "speech_vad_model") {
#if defined(SHERPA_SEG_ENGINE_STUB_INFERENCE)
    return seg_fail(errorCode, error, "POLICY_MODEL_UNAVAILABLE",
                    "speech_vad_model runtime is unavailable");
#else
    auto tempEngine = std::make_shared<SegEngine>();
    tempEngine->attachedBufferId = bufferId;
    tempEngine->policy = p;
    std::string vadError;
    if (!seg_init_vad_runtime(tempEngine, sampleRate, &vadError)) {
      return seg_fail(errorCode, error, "POLICY_MODEL_UNAVAILABLE",
                      vadError.empty() ? "speech_vad_model runtime init failed" : vadError);
    }
    const int frameSize = std::max(1, tempEngine->vadFrameSize);
    const int chunkSize = std::max(frameSize, frameSize * 8);
    std::vector<float> pending;

    auto appendRecord = [&](int startSample, int endSample, const std::string &reason) {
      if (endSample <= startSample) return;
      SegRecord rec;
      rec.id = "seg_" + seg_uuid();
      rec.kind = "speech";
      rec.sourceAudioBufferId = bufferId;
      rec.startSample = startSample;
      rec.endSample = endSample;
      rec.sampleRate = sampleRate;
      rec.durationMs = static_cast<int>(((endSample - startSample) * 1000.0) / std::max(1, sampleRate));
      rec.payloadJson = seg_vad_payload_json(false, 0.0);
      records.push_back(rec);
      seg_record_annotation(rec.id, reason, static_cast<int>(records.size()) - 1);
    };

    int cursor = 0;
    while (cursor < totalSamples) {
      std::vector<float> chunk;
      std::string sliceErrCode;
      std::string sliceErrMessage;
      const int readCount = std::min(chunkSize, totalSamples - cursor);
      if (!pa_get_offline_samples_slice(bufferId, cursor, readCount, &chunk, &sliceErrCode,
                                        &sliceErrMessage)) {
        return seg_fail(errorCode, error, "BUFFER_STATE_INVALID",
                        sliceErrMessage.empty() ? "Failed to read offline audio slice"
                                                : sliceErrMessage);
      }
      cursor += static_cast<int>(chunk.size());
      if (chunk.empty()) break;
      pending.insert(pending.end(), chunk.begin(), chunk.end());
      while (static_cast<int>(pending.size()) >= frameSize) {
        tempEngine->vadRuntime->acceptWaveform(pending.data(), frameSize);
        const auto segments = tempEngine->vadRuntime->popSegments();
        for (const auto &segment : segments) {
          appendRecord(segment.startSample, segment.endSample, "vad_boundary");
        }
        pending.erase(pending.begin(), pending.begin() + frameSize);
      }
    }
    if (!pending.empty()) {
      std::vector<float> tail(static_cast<size_t>(frameSize), 0.0f);
      std::copy(pending.begin(), pending.end(), tail.begin());
      tempEngine->vadRuntime->acceptWaveform(tail.data(), frameSize);
      const auto segments = tempEngine->vadRuntime->popSegments();
      for (const auto &segment : segments) {
        appendRecord(segment.startSample, segment.endSample, "vad_boundary");
      }
    }
    tempEngine->vadRuntime->flush();
    const auto tailSegments = tempEngine->vadRuntime->popSegments();
    for (const auto &segment : tailSegments) {
      appendRecord(segment.startSample, segment.endSample, "finalize");
    }
#endif
  } else if (p.evaluator == "speech_pyannote_segmentation") {
#if defined(SHERPA_SEG_ENGINE_STUB_INFERENCE)
    return seg_fail(errorCode, error, "POLICY_MODEL_UNAVAILABLE",
                    "speech_pyannote_segmentation runtime is unavailable");
#else
    if (p.modelPath.empty() || !seg_path_is_regular_file(p.modelPath)) {
      return seg_fail(errorCode, error, "POLICY_MODEL_UNAVAILABLE",
                      "speech_pyannote_segmentation modelPath must be an existing .onnx file: " +
                          p.modelPath);
    }
    auto session = std::make_shared<sherpaonnx::diarization::PyannoteSegmentationSession>();
    sherpaonnx::diarization::PyannoteSegOptions options;
    options.model_path = p.modelPath;
    options.window_shift_ratio = static_cast<float>(p.windowShiftRatio);
    options.min_duration_on = static_cast<float>(p.minDurationOn);
    options.min_duration_off = static_cast<float>(p.minDurationOff);
    const auto initStatus = session->Initialize(options);
    if (!initStatus.ok) {
      return seg_fail(errorCode, error, "POLICY_MODEL_UNAVAILABLE",
                      seg_status_message(initStatus,
                                         "speech_pyannote_segmentation failed to initialize runtime"));
    }

    std::vector<float> samples;
    if (totalSamples > 0) {
      std::string sliceErrCode;
      std::string sliceErrMessage;
      if (!pa_get_offline_samples_slice(bufferId, 0, totalSamples, &samples, &sliceErrCode,
                                        &sliceErrMessage)) {
        return seg_fail(errorCode, error, "BUFFER_STATE_INVALID",
                        sliceErrMessage.empty() ? "Failed to read offline audio slice"
                                                : sliceErrMessage);
      }
    }
    std::vector<sherpaonnx::diarization::PyannoteSpeechSpan> spans;
    if (!samples.empty()) {
      const auto processStatus = session->ProcessMono(
          samples.data(), static_cast<int32_t>(samples.size()), sampleRate, &spans);
      if (!processStatus.ok) {
        return seg_fail(errorCode, error, "POLICY_MODEL_UNAVAILABLE",
                        seg_status_message(processStatus,
                                           "speech_pyannote_segmentation process failed"));
      }
    }

    const int minSamples =
        std::max(1, static_cast<int>((p.minSegmentMs / 1000.0) * sampleRate));
    const int maxSamples =
        std::max(minSamples, static_cast<int>((p.maxSegmentMs / 1000.0) * sampleRate));
    const std::string payloadJson = seg_pyannote_payload_json();
    auto appendPyannote = [&](int startSample, int endSample, const std::string &reason) {
      if (endSample <= startSample) return;
      const int durationMs = static_cast<int>(
          ((endSample - startSample) * 1000.0) / std::max(1, sampleRate));
      if (durationMs < p.minSegmentMs) return;
      SegRecord rec;
      rec.id = "seg_" + seg_uuid();
      rec.kind = "speech";
      rec.sourceAudioBufferId = bufferId;
      rec.startSample = startSample;
      rec.endSample = endSample;
      rec.sampleRate = sampleRate;
      rec.durationMs = durationMs;
      rec.payloadJson = payloadJson;
      records.push_back(rec);
      seg_record_annotation(rec.id, reason, static_cast<int>(records.size()) - 1);
    };

    for (size_t i = 0; i < spans.size(); ++i) {
      int start = static_cast<int>(std::lround(static_cast<double>(spans[i].start) * sampleRate));
      int end = static_cast<int>(std::lround(static_cast<double>(spans[i].end) * sampleRate));
      start = std::max(0, std::min(start, totalSamples));
      end = std::max(0, std::min(end, totalSamples));
      if (end <= start) continue;
      if (end - start < minSamples) continue;
      while (end - start > maxSamples) {
        const int chunkEnd = start + maxSamples;
        appendPyannote(start, chunkEnd, "length_limit");
        start = chunkEnd;
      }
      const std::string reason =
          (i + 1 == spans.size()) ? "finalize" : "pyannote_boundary";
      appendPyannote(start, end, reason);
    }
#endif
  } else {
    const int minSamples =
        std::max(1, static_cast<int>((p.minSegmentMs / 1000.0) * sampleRate));
    const int maxSamples =
        std::max(minSamples, static_cast<int>((p.maxSegmentMs / 1000.0) * sampleRate));
    const int silenceSamples = std::max(
        1, static_cast<int>(((p.silenceThresholdMs + p.hangoverMs) / 1000.0) * sampleRate));
    const int frameSize = std::max(160, sampleRate / 50);
    int start = 0;
    int cursor = 0;
    int silenceRun = 0;
    while (cursor < totalSamples) {
      const int readCount = std::min(frameSize, totalSamples - cursor);
      std::vector<float> frame;
      std::string sliceErrCode;
      std::string sliceErrMessage;
      if (!pa_get_offline_samples_slice(bufferId, cursor, readCount, &frame, &sliceErrCode,
                                        &sliceErrMessage)) {
        return seg_fail(errorCode, error, "BUFFER_STATE_INVALID",
                        sliceErrMessage.empty() ? "Failed to read offline audio slice"
                                                : sliceErrMessage);
      }
      if (frame.empty()) break;
      const int end = cursor + static_cast<int>(frame.size());
      const double db = seg_rms_db(frame.data(), frame.size());
      if (db < p.energyThresholdDb) silenceRun += static_cast<int>(frame.size());
      else silenceRun = 0;
      const int segLen = end - start;
      const bool silenceCommit = silenceRun >= silenceSamples && segLen >= minSamples;
      const bool lengthCommit = segLen >= maxSamples;
      if (silenceCommit || lengthCommit) {
        SegRecord rec;
        rec.id = "seg_" + seg_uuid();
        rec.kind = "speech";
        rec.sourceAudioBufferId = bufferId;
        rec.startSample = start;
        rec.endSample = end;
        rec.sampleRate = sampleRate;
        rec.durationMs = static_cast<int>(((end - start) * 1000.0) / sampleRate);
        rec.payloadJson = seg_vad_payload_json(true, db);
        records.push_back(rec);
        seg_record_annotation(rec.id, seg_reason_from_eval(p.evaluator, silenceCommit),
                              static_cast<int>(records.size()) - 1);
        start = end;
        silenceRun = 0;
      }
      cursor = end;
    }
    if (start < totalSamples) {
      SegRecord rec;
      rec.id = "seg_" + seg_uuid();
      rec.kind = "speech";
      rec.sourceAudioBufferId = bufferId;
      rec.startSample = start;
      rec.endSample = totalSamples;
      rec.sampleRate = sampleRate;
      rec.durationMs =
          static_cast<int>(((totalSamples - start) * 1000.0) / std::max(1, sampleRate));
      rec.payloadJson = seg_vad_payload_json(false, 0.0);
      records.push_back(rec);
      seg_record_annotation(rec.id, "finalize", static_cast<int>(records.size()) - 1);
    }
  }

  auto off = std::make_shared<SegOfflineEntry>();
  off->bufferId = seg_generate_id("seg_off");
  off->segments = std::move(records);
  off->sourceAudioBufferId = bufferId;
  off->populated = true;
  const int count = static_cast<int>(off->segments.size());
  {
    std::lock_guard<std::mutex> lock(g_seg_mutex);
    g_seg_offline[off->bufferId] = off;
  }
  *outBufferId = off->bufferId;
  if (segmentCount) *segmentCount = count;
  seg_engine_log("offline speech src=%s seg=%s count=%d evaluator=%s", bufferId.c_str(),
                 off->bufferId.c_str(), count, p.evaluator.c_str());
  return true;
}

}  // namespace

void seg_engine_on_text_write(const std::string &liveBufferId) {
  std::shared_ptr<SegEngine> engine;
  {
    std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
    auto itId = g_seg_engine_id_by_buffer.find(liveBufferId);
    if (itId == g_seg_engine_id_by_buffer.end()) return;
    auto itEngine = g_seg_engine_by_id.find(itId->second);
    if (itEngine == g_seg_engine_by_id.end()) return;
    engine = itEngine->second;
    if (!g_seg_engine_eval_guard.insert(liveBufferId).second) return;
  }
  EvalGuard guard(liveBufferId);
  seg_engine_evaluate_text(engine);
}

void seg_engine_on_audio_append(const std::string &liveBufferId, const float *samples, size_t count,
                                int sampleRate, int64_t totalSamplesWritten) {
  std::shared_ptr<SegEngine> engine;
  {
    std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
    auto itId = g_seg_engine_id_by_buffer.find(liveBufferId);
    if (itId == g_seg_engine_id_by_buffer.end()) return;
    auto itEngine = g_seg_engine_by_id.find(itId->second);
    if (itEngine == g_seg_engine_by_id.end()) return;
    engine = itEngine->second;
    if (!g_seg_engine_eval_guard.insert(liveBufferId).second) return;
  }
  EvalGuard guard(liveBufferId);
  seg_engine_evaluate_audio(engine, samples, count, sampleRate, totalSamplesWritten);
}

void seg_engine_on_buffer_finalized(const std::string &bufferId) {
  std::shared_ptr<SegEngine> engine;
  {
    std::unique_lock<std::mutex> lock(g_seg_engine_mutex);
    g_seg_engine_eval_cv.wait(lock, [&bufferId] {
      return g_seg_engine_eval_guard.find(bufferId) == g_seg_engine_eval_guard.end();
    });
    auto itId = g_seg_engine_id_by_buffer.find(bufferId);
    if (itId == g_seg_engine_id_by_buffer.end()) return;
    auto itEngine = g_seg_engine_by_id.find(itId->second);
    if (itEngine == g_seg_engine_by_id.end()) return;
    g_seg_engine_eval_guard.insert(bufferId);
    engine = itEngine->second;
  }
  EvalGuard guard(bufferId);
  if (engine->state == SegEngineState::Active) {
    if (engine->domain == SegEngineDomain::Text) seg_engine_flush_text(engine);
    else seg_engine_flush_audio(engine);
  }
  {
    std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
    if (engine->state == SegEngineState::Active) engine->state = SegEngineState::Detached;
    g_seg_engine_id_by_buffer.erase(bufferId);
  }
}

void seg_engine_on_buffer_released(const std::string &bufferId) {
  std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
  auto itId = g_seg_engine_id_by_buffer.find(bufferId);
  if (itId == g_seg_engine_id_by_buffer.end()) return;
  auto itEngine = g_seg_engine_by_id.find(itId->second);
  if (itEngine != g_seg_engine_by_id.end()) {
    auto &engine = itEngine->second;
    for (const auto &sid : engine->annotatedSegmentIds) {
      g_seg_engine_annotation_by_segment.erase(sid);
    }
    engine->state = SegEngineState::Released;
    g_seg_engine_by_id.erase(itEngine);
  }
  g_seg_engine_id_by_buffer.erase(itId);
}

bool seg_engine_detach(const std::string &engineId, bool flushFinal, std::string *error) {
  std::shared_ptr<SegEngine> engine;
  {
    std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
    auto it = g_seg_engine_by_id.find(engineId);
    if (it == g_seg_engine_by_id.end()) {
      if (error) *error = "ENGINE_DETACHED: Segmentation engine not found: " + engineId;
      return false;
    }
    engine = it->second;
  }
  if (engine->state != SegEngineState::Active) {
    if (error) *error = "ENGINE_DETACHED: Segmentation engine already detached: " + engineId;
    return false;
  }
  if (flushFinal) {
    if (engine->domain == SegEngineDomain::Text) seg_engine_flush_text(engine);
    else seg_engine_flush_audio(engine);
  }
  engine->state = SegEngineState::Detached;
  {
    std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
    g_seg_engine_id_by_buffer.erase(engine->attachedBufferId);
  }
  return true;
}

bool seg_engine_flush(const std::string &engineId, std::string *error) {
  (void)error;
  std::shared_ptr<SegEngine> engine;
  {
    std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
    auto it = g_seg_engine_by_id.find(engineId);
    if (it == g_seg_engine_by_id.end()) return true;
    engine = it->second;
    if (engine->state != SegEngineState::Active) return true;
  }
  if (engine->domain == SegEngineDomain::Text) seg_engine_flush_text(engine);
  else seg_engine_flush_audio(engine);
  return true;
}

bool seg_engine_peek_annotation(const std::string &segmentId, std::string *reason,
                                std::string *source, int64_t *createdAtMs, int *segmentIndex) {
  std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
  auto it = g_seg_engine_annotation_by_segment.find(segmentId);
  if (it == g_seg_engine_annotation_by_segment.end()) return false;
  if (reason) *reason = it->second.reason;
  if (source) *source = it->second.source;
  if (createdAtMs) *createdAtMs = it->second.createdAtMs;
  if (segmentIndex) *segmentIndex = it->second.segmentIndex;
  return true;
}

void seg_engine_record_annotation(const std::string &segmentId, const std::string &reason,
                                  const std::string &source, int64_t createdAtMs, int segmentIndex) {
  if (segmentId.empty()) return;
  std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
  g_seg_engine_annotation_by_segment[segmentId] =
      SegEngineAnnotation{reason, source, createdAtMs, segmentIndex};
}

void seg_engine_release_all() {
  std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
  for (auto &kv : g_seg_engine_by_id) {
    if (kv.second) kv.second->state = SegEngineState::Released;
  }
  g_seg_engine_by_id.clear();
  g_seg_engine_id_by_buffer.clear();
  g_seg_engine_annotation_by_segment.clear();
  g_seg_engine_eval_guard.clear();
}

bool seg_engine_attach(const std::string &bufferId, const std::string &domain,
                       const SegEnginePolicy &policy, SegEngineInfoSnapshot *out,
                       std::string *errorCode, std::string *error) {
  try {
    SegEngineDomain d;
    if (!seg_parse_domain(domain, &d, errorCode, error)) return false;
    if (!seg_validate_boundary_chars(policy.sentenceBoundaryChars, errorCode, error)) return false;

    {
      std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
      if (g_seg_engine_id_by_buffer.find(bufferId) != g_seg_engine_id_by_buffer.end()) {
        return seg_fail(errorCode, error, "ENGINE_ALREADY_ATTACHED",
                        "Segmentation engine already attached for buffer: " + bufferId);
      }
    }

    if (d == SegEngineDomain::Text) {
      auto live = txt_get_live_entry(bufferId);
      if (!live || live->state != TxtLiveEntry::RECORDING) {
        return seg_fail(errorCode, error, "BUFFER_STATE_INVALID",
                        "Live text buffer is not recording: " + bufferId);
      }
    } else {
      auto live = pa_get_live_entry(bufferId);
      if (!live || live->state != PaLiveEntry::RECORDING) {
        return seg_fail(errorCode, error, "BUFFER_STATE_INVALID",
                        "Live audio buffer is not recording: " + bufferId);
      }
    }

    auto engine = std::make_shared<SegEngine>();
    engine->engineId = "seg_engine_" + seg_uuid();
    engine->domain = d;
    engine->state = SegEngineState::Active;
    engine->attachedBufferId = bufferId;
    engine->policy = policy;
    seg_normalize_policy(engine->policy, d == SegEngineDomain::Text);

    if (d == SegEngineDomain::Text) {
      if (!seg_validate_text_evaluator(engine->policy, true, errorCode, error)) return false;
    } else if (!seg_validate_speech_evaluator_live(engine->policy, errorCode, error)) {
      return false;
    }

    if (d == SegEngineDomain::Speech) {
      std::string createErr;
      if (!seg_create_live(bufferId, 4096, "on", "", true, 0, true, 0, &engine->segmentBufferId,
                           &createErr)) {
        return seg_fail(errorCode, error, "SEGMENT_INTERNAL_ERROR",
                        createErr.empty() ? "Failed to create live segment buffer" : createErr);
      }
      if (engine->policy.evaluator == "speech_vad_model") {
        auto live = pa_get_live_entry(bufferId);
        if (!live) {
          seg_release_buffer(engine->segmentBufferId);
          engine->segmentBufferId.clear();
          return seg_fail(errorCode, error, "BUFFER_STATE_INVALID",
                          "Live audio buffer not found: " + bufferId);
        }
        std::string vadError;
        if (!seg_init_vad_runtime(engine, live->sampleRate, &vadError)) {
          seg_release_buffer(engine->segmentBufferId);
          engine->segmentBufferId.clear();
          return seg_fail(errorCode, error, "POLICY_MODEL_UNAVAILABLE",
                          vadError.empty() ? "speech_vad_model runtime init failed" : vadError);
        }
      }
    }

    bool duplicate = false;
    {
      std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
      duplicate = g_seg_engine_id_by_buffer.find(bufferId) != g_seg_engine_id_by_buffer.end();
      if (!duplicate) {
        g_seg_engine_by_id[engine->engineId] = engine;
        g_seg_engine_id_by_buffer[engine->attachedBufferId] = engine->engineId;
      }
    }
    if (duplicate) {
      if (!engine->segmentBufferId.empty()) seg_release_buffer(engine->segmentBufferId);
      return seg_fail(errorCode, error, "ENGINE_ALREADY_ATTACHED",
                      "Segmentation engine already attached for buffer: " + bufferId);
    }
    if (out) *out = seg_engine_snapshot(*engine);
    seg_engine_log("attach id=%s buffer=%s domain=%s evaluator=%s seg=%s", engine->engineId.c_str(),
                   bufferId.c_str(), d == SegEngineDomain::Text ? "text" : "speech",
                   engine->policy.evaluator.c_str(), engine->segmentBufferId.c_str());
    return true;
  } catch (const std::exception &e) {
    return seg_fail(errorCode, error, "SEGMENT_INTERNAL_ERROR", e.what());
  }
}

bool seg_engine_get_info(const std::string &engineId, SegEngineInfoSnapshot *out,
                         std::string *errorCode, std::string *error) {
  if (out == nullptr) {
    return seg_fail(errorCode, error, "SEGMENT_INTERNAL_ERROR", "info output is null");
  }
  std::lock_guard<std::mutex> lock(g_seg_engine_mutex);
  auto it = g_seg_engine_by_id.find(engineId);
  if (it == g_seg_engine_by_id.end() || !it->second) {
    return seg_fail(errorCode, error, "ENGINE_DETACHED",
                    "Segmentation engine not found: " + engineId);
  }
  *out = seg_engine_snapshot(*it->second);
  return true;
}

bool seg_engine_segment_offline(const std::string &bufferId, const std::string &domain,
                                const SegEnginePolicy &policy,
                                std::vector<SegOfflineTextSegment> *textSegments,
                                std::string *outBufferId, int *segmentCount,
                                std::string *errorCode, std::string *error) {
  try {
    SegEngineDomain d;
    if (!seg_parse_domain(domain, &d, errorCode, error)) return false;
    if (d == SegEngineDomain::Text) {
      return seg_segment_offline_text(bufferId, policy, textSegments, outBufferId, segmentCount,
                                      errorCode, error);
    }
    if (textSegments) textSegments->clear();
    return seg_segment_offline_speech(bufferId, policy, outBufferId, segmentCount, errorCode,
                                      error);
  } catch (const std::exception &e) {
    return seg_fail(errorCode, error, "SEGMENT_INTERNAL_ERROR", e.what());
  }
}
