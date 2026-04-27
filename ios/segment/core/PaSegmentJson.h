#pragma once

#ifdef __cplusplus

#include <sstream>
#include <string>

#include "PaSegment.h"
#include "PaSegmentLink.h"

// Phase 1a lightweight JSON helpers for debugging/bridge shaping.
// Intentionally minimal and dependency-free.

namespace pa_segment_json {

inline std::string Escape(const std::string &in) {
  std::string out;
  out.reserve(in.size() + 8);
  for (char c : in) {
    switch (c) {
      case '\\': out += "\\\\"; break;
      case '"': out += "\\\""; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default: out += c; break;
    }
  }
  return out;
}

inline const char *DomainRaw(PaSegmentDomain d) {
  return d == PaSegmentDomain::Text ? "text" : "speech";
}

inline const char *ReasonRaw(PaSegmentReason r) {
  switch (r) {
    case PaSegmentReason::Endpoint: return "endpoint";
    case PaSegmentReason::Punctuation: return "punctuation";
    case PaSegmentReason::LengthLimit: return "length_limit";
    case PaSegmentReason::VadBoundary: return "vad_boundary";
    case PaSegmentReason::EnergySilence: return "energy_silence";
    case PaSegmentReason::ManualCommit: return "manual_commit";
    case PaSegmentReason::Finalize: return "finalize";
    case PaSegmentReason::PolicyCheckpoint: return "policy_checkpoint";
  }
  return "manual_commit";
}

inline const char *SourceRaw(PaSegmentSource s) {
  switch (s) {
    case PaSegmentSource::SegmentationEngine: return "segmentation_engine";
    case PaSegmentSource::Manual: return "manual";
    case PaSegmentSource::External: return "external";
  }
  return "manual";
}

inline std::string SegmentToJson(const PaSegmentBase &s) {
  std::ostringstream oss;
  oss << "{"
      << "\"segmentId\":\"" << Escape(s.segmentId) << "\","
      << "\"domain\":\"" << DomainRaw(s.domain) << "\","
      << "\"startOffset\":" << s.startOffset << ","
      << "\"endOffset\":" << s.endOffset << ","
      << "\"reason\":\"" << ReasonRaw(s.reason) << "\","
      << "\"source\":\"" << SourceRaw(s.source) << "\","
      << "\"createdAtMs\":" << s.createdAtMs << ","
      << "\"segmentIndex\":" << s.segmentIndex
      << "}";
  return oss.str();
}

inline const char *LinkTypeRaw(PaSegmentLinkType t) {
  switch (t) {
    case PaSegmentLinkType::Alignment: return "alignment";
    case PaSegmentLinkType::Proportional: return "proportional";
    case PaSegmentLinkType::VadAssisted: return "vad_assisted";
    case PaSegmentLinkType::Sequential: return "sequential";
    case PaSegmentLinkType::TtsProduced: return "tts_produced";
    case PaSegmentLinkType::SttProduced: return "stt_produced";
    case PaSegmentLinkType::UserDefined: return "user_defined";
  }
  return "user_defined";
}

inline std::string SegmentLinkToJson(const PaSegmentLink &l) {
  std::ostringstream oss;
  oss << "{"
      << "\"linkId\":\"" << Escape(l.linkId) << "\","
      << "\"textSegmentId\":\"" << Escape(l.textSegmentId) << "\","
      << "\"speechSegmentId\":\"" << Escape(l.speechSegmentId) << "\","
      << "\"linkType\":\"" << LinkTypeRaw(l.linkType) << "\"";
  if (l.confidence.has_value()) {
    oss << ",\"confidence\":" << l.confidence.value();
  }
  oss << "}";
  return oss.str();
}

} // namespace pa_segment_json

#endif // __cplusplus

