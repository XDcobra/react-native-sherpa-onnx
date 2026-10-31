#include "codec/CodecTypes.h"

#include <algorithm>
#include <cctype>
#include <cstdio>

namespace sherpa_onnx {
namespace codec {
namespace {

std::string Lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return s;
}

}  // namespace

const char* MediaName(Media m) {
  switch (m) {
    case Media::Video:
      return "video";
    case Media::Image:
      return "image";
    case Media::Audio:
      return "audio";
  }
  return "video";
}

const char* DirectionName(Direction d) {
  return d == Direction::Encode ? "encode" : "decode";
}

const char* UseName(Use u) {
  switch (u) {
    case Use::Cpu:
      return "cpu";
    case Use::Display:
      return "display";
    case Use::Export:
      return "export";
  }
  return "cpu";
}

const char* TierName(Tier t) {
  switch (t) {
    case Tier::Hardware:
      return "hardware";
    case Tier::Software:
      return "software";
    case Tier::Unknown:
      return "unknown";
  }
  return "unknown";
}

const char* OriginName(Origin o) {
  return o == Origin::Bundled ? "bundled" : "platform";
}

const char* PolicyName(Policy p) {
  switch (p) {
    case Policy::Hardware:
      return "hardware";
    case Policy::Software:
      return "software";
    case Policy::PreferHardware:
      return "preferHardware";
  }
  return "preferHardware";
}

const char* ReasonName(Reason r) {
  switch (r) {
    case Reason::None:
      return "none";
    case Reason::PoolFull:
      return "pool-full";
    case Reason::NotPresent:
      return "not-present";
    case Reason::Disabled:
      return "disabled";
    case Reason::OsTooOld:
      return "os-too-old";
    case Reason::UnsupportedStream:
      return "unsupported-stream";
    case Reason::ConfigureFailed:
      return "configure-failed";
    case Reason::Reclaimed:
      return "reclaimed";
    case Reason::InvalidSession:
      return "invalid-session";
    case Reason::SwTooSlow:
      return "sw-too-slow";
  }
  return "none";
}

const char* ResourceName(ResourceClass c) {
  switch (c) {
    case ResourceClass::HwVideoDecodeCpu:
      return "hw.dec.cpu";
    case ResourceClass::HwVideoDecodeDisplay:
      return "hw.dec.display";
    case ResourceClass::HwVideoEncode:
      return "hw.enc";
    case ResourceClass::SwVideoDecode:
      return "sw.dec";
    case ResourceClass::SwVideoEncode:
      return "sw.enc";
    case ResourceClass::PlatformImageDecode:
      return "platform.image.decode";
  }
  return "hw.dec.cpu";
}

const char* ResourceJsName(ResourceClass c) {
  switch (c) {
    case ResourceClass::HwVideoDecodeCpu:
      return "hwVideoDecode";
    case ResourceClass::HwVideoDecodeDisplay:
      return "hwVideoDisplay";
    case ResourceClass::HwVideoEncode:
      return "hwVideoEncode";
    case ResourceClass::SwVideoDecode:
      return "swVideoDecode";
    case ResourceClass::SwVideoEncode:
      return "swVideoEncode";
    case ResourceClass::PlatformImageDecode:
      return "platformImageDecode";
  }
  return "hwVideoDecode";
}

const char* RamClassName(RamClass r) {
  switch (r) {
    case RamClass::Low:
      return "low";
    case RamClass::Mid:
      return "mid";
    case RamClass::High:
      return "high";
    case RamClass::VeryHigh:
      return "veryHigh";
  }
  return "mid";
}

std::optional<Policy> ParsePolicy(const std::string& s) {
  const std::string v = Lower(s);
  if (v == "hardware") return Policy::Hardware;
  if (v == "software") return Policy::Software;
  if (v == "preferhardware") return Policy::PreferHardware;
  return std::nullopt;
}

std::optional<ResourceClass> ParseResourceJs(const std::string& s) {
  if (s == "hwVideoDecode") return ResourceClass::HwVideoDecodeCpu;
  if (s == "hwVideoDisplay") return ResourceClass::HwVideoDecodeDisplay;
  if (s == "hwVideoEncode") return ResourceClass::HwVideoEncode;
  if (s == "swVideoDecode") return ResourceClass::SwVideoDecode;
  if (s == "swVideoEncode") return ResourceClass::SwVideoEncode;
  if (s == "platformImageDecode") return ResourceClass::PlatformImageDecode;
  return std::nullopt;
}

ResourceClass ResourceFor(const Request& req, Tier tier) {
  if (req.media == Media::Image) {
    return ResourceClass::PlatformImageDecode;
  }
  if (req.dir == Direction::Encode) {
    return tier == Tier::Software ? ResourceClass::SwVideoEncode
                                 : ResourceClass::HwVideoEncode;
  }
  if (tier == Tier::Software) {
    return ResourceClass::SwVideoDecode;
  }
  return req.use == Use::Display ? ResourceClass::HwVideoDecodeDisplay
                                 : ResourceClass::HwVideoDecodeCpu;
}

const char* ErrorCodeFor(const Request& req, Reason reason, Tier attempted) {
  if (req.media == Media::Image) {
    if (attempted == Tier::Software || reason == Reason::Disabled) {
      return kErrImageSwDecoderUnavailable;
    }
    return kErrImageHwDecoderUnavailable;
  }
  if (req.dir == Direction::Encode) {
    if (attempted == Tier::Software || reason == Reason::Disabled) {
      return kErrVideoSwEncoderDisabled;
    }
    return kErrVideoEncoderUnavailable;
  }
  if (attempted == Tier::Software || reason == Reason::Disabled) {
    return kErrVideoSwDecoderDisabled;
  }
  if (req.use == Use::Display && reason == Reason::PoolFull) {
    return kErrPreviewDecoderBusy;
  }
  return kErrVideoDecoderUnavailable;
}

std::string EscapeJson(const std::string& s) {
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
          out += static_cast<char>(c);
        }
    }
  }
  return out;
}

std::string DecisionToJson(const Decision& d) {
  std::string out = "{\"tier\":\"";
  out += TierName(d.tier);
  out += "\",\"origin\":\"";
  out += OriginName(d.origin);
  out += "\",\"provider\":\"";
  out += EscapeJson(d.provider);
  out += "\"";
  if (d.fellBack) {
    out += ",\"fallbackFrom\":{\"code\":\"";
    out += EscapeJson(d.fallbackCode);
    out += "\",\"reason\":\"";
    out += ReasonName(d.fallbackReason);
    out += "\"}";
  }
  if (!d.attempts.empty()) {
    out += ",\"attempts\":[";
    for (size_t i = 0; i < d.attempts.size(); ++i) {
      if (i) out += ",";
      out += "{\"provider\":\"";
      out += EscapeJson(d.attempts[i].provider);
      out += "\",\"tier\":\"";
      out += TierName(d.attempts[i].tier);
      out += "\",\"origin\":\"";
      out += OriginName(d.attempts[i].origin);
      out += "\",\"reason\":\"";
      out += ReasonName(d.attempts[i].reason);
      out += "\"";
      if (!d.attempts[i].code.empty()) {
        out += ",\"code\":\"";
        out += EscapeJson(d.attempts[i].code);
        out += "\"";
      }
      out += "}";
    }
    out += "]";
  }
  out += "}";
  return out;
}

}  // namespace codec
}  // namespace sherpa_onnx
