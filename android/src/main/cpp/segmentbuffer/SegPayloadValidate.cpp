#include "SegPayloadValidate.h"

#include <cctype>
#include <cmath>
#include <string>
#include <unordered_map>
#include <unordered_set>

namespace {

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
          if (i + 4 <= s.size()) i += 4;
          v.push_back('?');
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
  size_t start = i;
  while (i < s.size() && !std::isspace(static_cast<unsigned char>(s[i])) && s[i] != ',' &&
         s[i] != '}' && s[i] != ']') {
    ++i;
  }
  if (start == i) return false;
  if (out) *out = s.substr(start, i - start);
  return true;
}

bool parseTopLevelObject(
    const std::string &json,
    std::unordered_map<std::string, std::string> *fields,
    std::string *error) {
  size_t i = 0;
  skipWs(json, i);
  if (i >= json.size() || json[i] != '{') {
    if (error) *error = "SEGMENT_INVALID_ARGUMENT: speech payload is required and must include source";
    return false;
  }
  ++i;
  skipWs(json, i);
  if (i < json.size() && json[i] == '}') return true;
  while (i < json.size()) {
    std::string key;
    if (!parseString(json, i, &key)) {
      if (error) *error = "SEGMENT_INVALID_ARGUMENT: speech payload is required and must include source";
      return false;
    }
    skipWs(json, i);
    if (i >= json.size() || json[i] != ':') {
      if (error) *error = "SEGMENT_INVALID_ARGUMENT: speech payload is required and must include source";
      return false;
    }
    ++i;
    std::string value;
    if (!extractJsonValue(json, i, &value)) {
      if (error) *error = "SEGMENT_INVALID_ARGUMENT: speech payload is required and must include source";
      return false;
    }
    if (fields) (*fields)[key] = value;
    skipWs(json, i);
    if (i < json.size() && json[i] == ',') {
      ++i;
      skipWs(json, i);
      continue;
    }
    if (i < json.size() && json[i] == '}') return true;
    if (error) *error = "SEGMENT_INVALID_ARGUMENT: speech payload is required and must include source";
    return false;
  }
  if (error) *error = "SEGMENT_INVALID_ARGUMENT: speech payload is required and must include source";
  return false;
}

bool isJsonNull(const std::string &raw) {
  size_t i = 0;
  skipWs(raw, i);
  return raw.compare(i, 4, "null") == 0;
}

bool isJsonString(const std::string &raw, std::string *decoded) {
  size_t i = 0;
  return parseString(raw, i, decoded);
}

bool isJsonNumber(const std::string &raw, double *out) {
  size_t i = 0;
  skipWs(raw, i);
  if (i >= raw.size()) return false;
  if (raw[i] == '"' || raw[i] == '{' || raw[i] == '[' || raw[i] == 't' || raw[i] == 'f' ||
      raw[i] == 'n') {
    return false;
  }
  size_t start = i;
  if (i < raw.size() && (raw[i] == '-' || raw[i] == '+')) ++i;
  bool any = false;
  while (i < raw.size() && (std::isdigit(static_cast<unsigned char>(raw[i])) || raw[i] == '.' ||
                            raw[i] == 'e' || raw[i] == 'E' || raw[i] == '+' || raw[i] == '-')) {
    any = true;
    ++i;
  }
  if (!any) return false;
  try {
    double v = std::stod(raw.substr(start, i - start));
    if (!std::isfinite(v)) return false;
    if (out) *out = v;
    return true;
  } catch (...) {
    return false;
  }
}

bool isJsonArray(const std::string &raw) {
  size_t i = 0;
  skipWs(raw, i);
  return i < raw.size() && raw[i] == '[';
}

const char *kSourceError =
    "SEGMENT_INVALID_ARGUMENT: speech payload.source must be one of vad, stt, tts, sid, "
    "pyannote, languageId, audioTagging, manual";

const std::unordered_set<std::string> kAnnotationKeys = {
    "__annotationReason",
    "__annotationSource",
    "__annotationCreatedAtMs",
};

std::unordered_set<std::string> allowedKeysForSource(const std::string &source) {
  std::unordered_set<std::string> keys = kAnnotationKeys;
  keys.insert("source");
  if (source == "vad") {
    keys.insert({"engine", "decision", "score"});
  } else if (source == "stt") {
    keys.insert({"transcript", "tokenCount", "isFinal"});
  } else if (source == "tts") {
    keys.insert({"text", "chunkIndex", "isFinalChunk"});
  } else if (source == "sid") {
    keys.insert("speakerName");
  } else if (source == "languageId") {
    keys.insert({"lang", "confidence"});
  } else if (source == "audioTagging") {
    keys.insert({"primaryName", "events"});
  } else if (source == "pyannote" || source == "manual") {
    // source + annotations only
  } else {
    keys.clear();
  }
  return keys;
}

void setError(std::string *error, const std::string &msg) {
  if (error) *error = msg;
}

}  // namespace

bool seg_validate_speech_payload_json(const std::string &payloadJson, std::string *error) {
  std::unordered_map<std::string, std::string> fields;
  if (!parseTopLevelObject(payloadJson, &fields, error)) return false;

  auto sourceIt = fields.find("source");
  if (sourceIt == fields.end()) {
    setError(error, kSourceError);
    return false;
  }
  std::string source;
  if (!isJsonString(sourceIt->second, &source) || source.empty()) {
    setError(error, kSourceError);
    return false;
  }

  auto allowed = allowedKeysForSource(source);
  if (allowed.empty()) {
    setError(error, kSourceError);
    return false;
  }

  for (const auto &kv : fields) {
    if (allowed.find(kv.first) == allowed.end()) {
      setError(error, "SEGMENT_INVALID_ARGUMENT: speech payload." + kv.first +
                          " is not allowed for source=" + source);
      return false;
    }
  }

  if (source == "vad") {
    auto eng = fields.find("engine");
    if (eng != fields.end()) {
      std::string engine;
      if (!isJsonString(eng->second, &engine) || engine != "vad") {
        setError(error, "SEGMENT_INVALID_ARGUMENT: speech payload.engine must be vad");
        return false;
      }
    }
    auto dec = fields.find("decision");
    if (dec != fields.end()) {
      std::string decision;
      if (!isJsonString(dec->second, &decision) || decision != "model") {
        setError(error, "SEGMENT_INVALID_ARGUMENT: speech payload.decision must be model");
        return false;
      }
    }
  }

  if (source == "sid") {
    auto sn = fields.find("speakerName");
    if (sn == fields.end()) {
      setError(error,
               "SEGMENT_INVALID_ARGUMENT: speech payload.speakerName is required for source=sid "
               "(string or null)");
      return false;
    }
    std::string speaker;
    if (!(isJsonNull(sn->second) || isJsonString(sn->second, &speaker))) {
      setError(error, "SEGMENT_INVALID_ARGUMENT: speech payload.speakerName must be a string or null");
      return false;
    }
  }

  if (source == "languageId") {
    auto langIt = fields.find("lang");
    std::string lang;
    if (langIt == fields.end() || !isJsonString(langIt->second, &lang) || lang.empty()) {
      setError(error,
               "SEGMENT_INVALID_ARGUMENT: speech payload.lang is required for source=languageId "
               "(non-empty string)");
      return false;
    }
    auto conf = fields.find("confidence");
    if (conf != fields.end() && !isJsonNull(conf->second)) {
      double c = 0;
      if (!isJsonNumber(conf->second, &c)) {
        setError(error,
                 "SEGMENT_INVALID_ARGUMENT: speech payload.confidence must be a finite number when "
                 "provided");
        return false;
      }
    }
  }

  if (source == "audioTagging") {
    auto pn = fields.find("primaryName");
    if (pn != fields.end() && !isJsonNull(pn->second)) {
      std::string name;
      if (!isJsonString(pn->second, &name)) {
        setError(error,
                 "SEGMENT_INVALID_ARGUMENT: speech payload.primaryName must be a string when "
                 "provided");
        return false;
      }
    }
    auto ev = fields.find("events");
    if (ev != fields.end() && !isJsonNull(ev->second)) {
      if (!isJsonArray(ev->second)) {
        setError(error,
                 "SEGMENT_INVALID_ARGUMENT: speech payload.events must be an array when provided");
        return false;
      }
    }
  }

  return true;
}
