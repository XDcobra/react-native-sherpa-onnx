#include "SegJson.h"

#include <cctype>
#include <cmath>
#include <cstdio>
#include <sstream>

namespace {

std::string escapeJsonString(const std::string &s) {
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
      case '\b':
        out += "\\b";
        break;
      case '\f':
        out += "\\f";
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
    }
  }
  return out;
}

void skipWs(const std::string &s, size_t &i) {
  while (i < s.size() && std::isspace(static_cast<unsigned char>(s[i]))) ++i;
}

bool parseString(const std::string &s, size_t &i, std::string *out) {
  skipWs(s, i);
  if (i >= s.size() || s[i] != '"') return false;
  ++i;
  std::string v;
  while (i < s.size()) {
    char c = s[i++];
    if (c == '"') {
      if (out) *out = v;
      return true;
    }
    if (c == '\\' && i < s.size()) {
      char e = s[i++];
      switch (e) {
        case '"':
        case '\\':
        case '/':
          v.push_back(e);
          break;
        case 'b':
          v.push_back('\b');
          break;
        case 'f':
          v.push_back('\f');
          break;
        case 'n':
          v.push_back('\n');
          break;
        case 'r':
          v.push_back('\r');
          break;
        case 't':
          v.push_back('\t');
          break;
        case 'u':
          if (i + 4 <= s.size()) {
            i += 4;  // skip unicode escape (best-effort)
            v.push_back('?');
          }
          break;
        default:
          v.push_back(e);
          break;
      }
    } else {
      v.push_back(c);
    }
  }
  return false;
}

bool parseNumber(const std::string &s, size_t &i, double *out) {
  skipWs(s, i);
  size_t start = i;
  if (i < s.size() && (s[i] == '-' || s[i] == '+')) ++i;
  while (i < s.size() && (std::isdigit(static_cast<unsigned char>(s[i])) || s[i] == '.' ||
                          s[i] == 'e' || s[i] == 'E' || s[i] == '+' || s[i] == '-')) {
    ++i;
  }
  if (start == i) return false;
  try {
    if (out) *out = std::stod(s.substr(start, i - start));
    return true;
  } catch (...) {
    return false;
  }
}

/** Extract balanced JSON value starting at i (object/array/string/number/literal). */
bool extractJsonValue(const std::string &s, size_t &i, std::string *out) {
  skipWs(s, i);
  if (i >= s.size()) return false;
  if (s[i] == '"') {
    size_t start = i;
    std::string tmp;
    if (!parseString(s, i, &tmp)) return false;
    if (out) *out = s.substr(start, i - start);
    return true;
  }
  if (s[i] == '{' || s[i] == '[') {
    char open = s[i];
    char close = open == '{' ? '}' : ']';
    int depth = 0;
    bool inStr = false;
    bool esc = false;
    size_t start = i;
    for (; i < s.size(); ++i) {
      char c = s[i];
      if (inStr) {
        if (esc) {
          esc = false;
        } else if (c == '\\') {
          esc = true;
        } else if (c == '"') {
          inStr = false;
        }
        continue;
      }
      if (c == '"') {
        inStr = true;
        continue;
      }
      if (c == open) ++depth;
      if (c == close) {
        --depth;
        if (depth == 0) {
          ++i;
          if (out) *out = s.substr(start, i - start);
          return true;
        }
      }
    }
    return false;
  }
  // number / true / false / null
  size_t start = i;
  while (i < s.size() && !std::isspace(static_cast<unsigned char>(s[i])) && s[i] != ',' &&
         s[i] != '}' && s[i] != ']') {
    ++i;
  }
  if (start == i) return false;
  if (out) *out = s.substr(start, i - start);
  return true;
}

bool findKeyObjectArray(const std::string &json, const char *key, size_t *valueStart) {
  std::string needle = std::string("\"") + key + "\"";
  size_t pos = 0;
  while (true) {
    pos = json.find(needle, pos);
    if (pos == std::string::npos) return false;
    size_t i = pos + needle.size();
    skipWs(json, i);
    if (i < json.size() && json[i] == ':') {
      ++i;
      skipWs(json, i);
      if (valueStart) *valueStart = i;
      return true;
    }
    pos += needle.size();
  }
}

}  // namespace

std::string segment_records_to_json(const std::vector<SegRecord> &segments) {
  std::ostringstream ss;
  ss << "{\"segments\":[";
  for (size_t i = 0; i < segments.size(); ++i) {
    const auto &s = segments[i];
    if (i) ss << ',';
    ss << "{\"id\":\"" << escapeJsonString(s.id) << "\"";
    ss << ",\"kind\":\"" << escapeJsonString(s.kind) << "\"";
    ss << ",\"sourceAudioBufferId\":\"" << escapeJsonString(s.sourceAudioBufferId) << "\"";
    ss << ",\"startSample\":" << s.startSample;
    ss << ",\"endSample\":" << s.endSample;
    ss << ",\"sampleRate\":" << s.sampleRate;
    ss << ",\"durationMs\":" << s.durationMs;
    if (s.hasConfidence) {
      ss << ",\"confidence\":" << s.confidence;
    }
    if (!s.payloadJson.empty()) {
      size_t pi = 0;
      skipWs(s.payloadJson, pi);
      if (pi < s.payloadJson.size() && (s.payloadJson[pi] == '{' || s.payloadJson[pi] == '[')) {
        ss << ",\"payload\":" << s.payloadJson;
      } else {
        ss << ",\"payload\":\"" << escapeJsonString(s.payloadJson) << "\"";
      }
    }
    ss << '}';
  }
  ss << "]}";
  return ss.str();
}

std::vector<SegRecord> segment_records_from_json(const std::string &json) {
  std::vector<SegRecord> out;
  size_t arrStart = 0;
  if (!findKeyObjectArray(json, "segments", &arrStart)) return out;
  skipWs(json, arrStart);
  if (arrStart >= json.size() || json[arrStart] != '[') return out;
  ++arrStart;
  size_t i = arrStart;
  while (true) {
    skipWs(json, i);
    if (i >= json.size()) break;
    if (json[i] == ']') break;
    if (json[i] == ',') {
      ++i;
      continue;
    }
    std::string obj;
    if (!extractJsonValue(json, i, &obj)) break;
    SegRecord r;
    size_t vs = 0;
    if (findKeyObjectArray(obj, "id", &vs)) {
      size_t j = vs;
      parseString(obj, j, &r.id);
    }
    if (findKeyObjectArray(obj, "kind", &vs)) {
      size_t j = vs;
      parseString(obj, j, &r.kind);
    }
    if (r.kind.empty()) r.kind = "speech";
    if (findKeyObjectArray(obj, "sourceAudioBufferId", &vs)) {
      size_t j = vs;
      parseString(obj, j, &r.sourceAudioBufferId);
    }
    double num = 0;
    if (findKeyObjectArray(obj, "startSample", &vs)) {
      size_t j = vs;
      if (parseNumber(obj, j, &num)) r.startSample = static_cast<int>(num);
    }
    if (findKeyObjectArray(obj, "endSample", &vs)) {
      size_t j = vs;
      if (parseNumber(obj, j, &num)) r.endSample = static_cast<int>(num);
    }
    if (findKeyObjectArray(obj, "sampleRate", &vs)) {
      size_t j = vs;
      if (parseNumber(obj, j, &num)) r.sampleRate = static_cast<int>(num);
    }
    if (findKeyObjectArray(obj, "durationMs", &vs)) {
      size_t j = vs;
      if (parseNumber(obj, j, &num)) r.durationMs = static_cast<int>(num);
    }
    if (findKeyObjectArray(obj, "confidence", &vs)) {
      size_t j = vs;
      if (parseNumber(obj, j, &num)) {
        r.hasConfidence = true;
        r.confidence = num;
      }
    }
    if (findKeyObjectArray(obj, "payload", &vs)) {
      size_t j = vs;
      std::string payload;
      if (extractJsonValue(obj, j, &payload)) {
        r.payloadJson = payload;
      }
    }
    out.push_back(std::move(r));
  }
  return out;
}
