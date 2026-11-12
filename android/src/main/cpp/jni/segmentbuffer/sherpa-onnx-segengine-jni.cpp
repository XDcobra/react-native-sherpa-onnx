/**
 * JNI facade for the shared SegEngine (attach / detach / info / offline / flush).
 * Policy is a JSON object built in Kotlin from the TurboModule ReadableMap.
 */
#include <android/log.h>
#include "jni/jni_utf8.h"
#include <jni.h>

#include "SegEngine.h"
#include "SegmentRegistry.h"

#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>
#include <utility>
#include <vector>

#define SEG_ENGINE_JNI_TAG "SherpaOnnx:segengine"

namespace {

JavaVM *g_vm = nullptr;
jclass g_bridge_class = nullptr;
jmethodID g_emit_from_native = nullptr;

std::string jstringToUtf8(JNIEnv *env, jstring s) {
  if (!s) return {};
  const char *chars = env->GetStringUTFChars(s, nullptr);
  std::string out = chars ? chars : "";
  if (chars) env->ReleaseStringUTFChars(s, chars);
  return out;
}

jstring utf8ToJstring(JNIEnv *env, const std::string &s) { return sherpaonnx::NewJStringUtf8(env, s); }

std::string jsonEscape(const std::string &s) {
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

struct JsonVal {
  enum Type { Null, Bool, Number, String, Array, Object } type = Null;
  bool b = false;
  double n = 0;
  std::string s;
  std::vector<JsonVal> a;
  std::vector<std::pair<std::string, JsonVal>> o;

  const JsonVal *field(const char *key) const {
    if (type != Object) return nullptr;
    for (const auto &kv : o) {
      if (kv.first == key) return &kv.second;
    }
    return nullptr;
  }
};

class JsonParser {
 public:
  explicit JsonParser(const std::string &in) : in_(in) {}

  bool parse(JsonVal *out, std::string *error) {
    skip();
    if (!parseValue(out, error)) return false;
    skip();
    if (i_ != in_.size()) {
      if (error) *error = "trailing data in policy JSON";
      return false;
    }
    return true;
  }

 private:
  const std::string &in_;
  size_t i_ = 0;

  void skip() {
    while (i_ < in_.size() && std::isspace(static_cast<unsigned char>(in_[i_]))) ++i_;
  }

  bool fail(std::string *error, const char *msg) {
    if (error) *error = msg;
    return false;
  }

  bool parseValue(JsonVal *out, std::string *error) {
    skip();
    if (i_ >= in_.size()) return fail(error, "unexpected end of policy JSON");
    const char c = in_[i_];
    if (c == 'n') return parseLiteral("null", out, JsonVal::Null, error);
    if (c == 't') return parseLiteral("true", out, JsonVal::Bool, error);
    if (c == 'f') return parseLiteral("false", out, JsonVal::Bool, error);
    if (c == '"') return parseString(&out->s, error) && (out->type = JsonVal::String, true);
    if (c == '{') return parseObject(out, error);
    if (c == '[') return parseArray(out, error);
    if (c == '-' || (c >= '0' && c <= '9')) return parseNumber(out, error);
    return fail(error, "invalid policy JSON value");
  }

  bool parseLiteral(const char *lit, JsonVal *out, JsonVal::Type type, std::string *error) {
    const size_t n = std::char_traits<char>::length(lit);
    if (in_.compare(i_, n, lit) != 0) return fail(error, "invalid policy JSON literal");
    i_ += n;
    out->type = type;
    if (type == JsonVal::Bool) out->b = lit[0] == 't';
    return true;
  }

  bool parseString(std::string *out, std::string *error) {
    if (i_ >= in_.size() || in_[i_] != '"') return fail(error, "expected string");
    ++i_;
    out->clear();
    while (i_ < in_.size()) {
      unsigned char c = static_cast<unsigned char>(in_[i_++]);
      if (c == '"') return true;
      if (c == '\\') {
        if (i_ >= in_.size()) return fail(error, "bad string escape");
        const char e = in_[i_++];
        switch (e) {
          case '"':
          case '\\':
          case '/':
            out->push_back(e);
            break;
          case 'b':
            out->push_back('\b');
            break;
          case 'f':
            out->push_back('\f');
            break;
          case 'n':
            out->push_back('\n');
            break;
          case 'r':
            out->push_back('\r');
            break;
          case 't':
            out->push_back('\t');
            break;
          case 'u': {
            if (i_ + 4 > in_.size()) return fail(error, "bad unicode escape");
            int cp = 0;
            for (int k = 0; k < 4; ++k) {
              const char h = in_[i_++];
              cp <<= 4;
              if (h >= '0' && h <= '9') cp += h - '0';
              else if (h >= 'a' && h <= 'f') cp += h - 'a' + 10;
              else if (h >= 'A' && h <= 'F') cp += h - 'A' + 10;
              else return fail(error, "bad unicode escape");
            }
            if (cp < 0x80) {
              out->push_back(static_cast<char>(cp));
            } else if (cp < 0x800) {
              out->push_back(static_cast<char>(0xC0 | (cp >> 6)));
              out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
            } else {
              out->push_back(static_cast<char>(0xE0 | (cp >> 12)));
              out->push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
              out->push_back(static_cast<char>(0x80 | (cp & 0x3F)));
            }
            break;
          }
          default:
            return fail(error, "bad string escape");
        }
      } else {
        out->push_back(static_cast<char>(c));
      }
    }
    return fail(error, "unterminated string");
  }

  bool parseNumber(JsonVal *out, std::string *error) {
    const size_t start = i_;
    if (in_[i_] == '-') ++i_;
    if (i_ >= in_.size() || !std::isdigit(static_cast<unsigned char>(in_[i_]))) {
      return fail(error, "invalid number");
    }
    while (i_ < in_.size() && std::isdigit(static_cast<unsigned char>(in_[i_]))) ++i_;
    if (i_ < in_.size() && in_[i_] == '.') {
      ++i_;
      while (i_ < in_.size() && std::isdigit(static_cast<unsigned char>(in_[i_]))) ++i_;
    }
    if (i_ < in_.size() && (in_[i_] == 'e' || in_[i_] == 'E')) {
      ++i_;
      if (i_ < in_.size() && (in_[i_] == '+' || in_[i_] == '-')) ++i_;
      while (i_ < in_.size() && std::isdigit(static_cast<unsigned char>(in_[i_]))) ++i_;
    }
    try {
      out->n = std::stod(in_.substr(start, i_ - start));
    } catch (...) {
      return fail(error, "invalid number");
    }
    out->type = JsonVal::Number;
    return true;
  }

  bool parseArray(JsonVal *out, std::string *error) {
    if (i_ >= in_.size() || in_[i_] != '[') return fail(error, "expected array");
    ++i_;
    out->type = JsonVal::Array;
    skip();
    if (i_ < in_.size() && in_[i_] == ']') {
      ++i_;
      return true;
    }
    while (i_ < in_.size()) {
      JsonVal item;
      if (!parseValue(&item, error)) return false;
      out->a.push_back(std::move(item));
      skip();
      if (i_ < in_.size() && in_[i_] == ',') {
        ++i_;
        continue;
      }
      if (i_ < in_.size() && in_[i_] == ']') {
        ++i_;
        return true;
      }
      return fail(error, "expected ',' or ']'");
    }
    return fail(error, "unterminated array");
  }

  bool parseObject(JsonVal *out, std::string *error) {
    if (i_ >= in_.size() || in_[i_] != '{') return fail(error, "expected object");
    ++i_;
    out->type = JsonVal::Object;
    skip();
    if (i_ < in_.size() && in_[i_] == '}') {
      ++i_;
      return true;
    }
    while (i_ < in_.size()) {
      skip();
      std::string key;
      if (!parseString(&key, error)) return false;
      skip();
      if (i_ >= in_.size() || in_[i_] != ':') return fail(error, "expected ':'");
      ++i_;
      JsonVal val;
      if (!parseValue(&val, error)) return false;
      out->o.emplace_back(std::move(key), std::move(val));
      skip();
      if (i_ < in_.size() && in_[i_] == ',') {
        ++i_;
        continue;
      }
      if (i_ < in_.size() && in_[i_] == '}') {
        ++i_;
        return true;
      }
      return fail(error, "expected ',' or '}'");
    }
    return fail(error, "unterminated object");
  }
};

int jsonInt(const JsonVal *v, int fallback) {
  if (!v || v->type != JsonVal::Number || !std::isfinite(v->n)) return fallback;
  return static_cast<int>(v->n);
}

double jsonDouble(const JsonVal *v, double fallback) {
  if (!v || v->type != JsonVal::Number || !std::isfinite(v->n)) return fallback;
  return v->n;
}

bool policyFromJson(const std::string &json, SegEnginePolicy *out, std::string *error) {
  if (!out) return false;
  if (json.empty() || json == "null") return true;
  JsonParser parser(json);
  JsonVal root;
  std::string parseError;
  if (!parser.parse(&root, &parseError) || root.type != JsonVal::Object) {
    if (error) *error = parseError.empty() ? "policy JSON must be an object" : parseError;
    return false;
  }
  if (const JsonVal *v = root.field("evaluator")) {
    if (v->type == JsonVal::String) out->evaluator = v->s;
    else if (v->type != JsonVal::Null) {
      if (error) *error = "evaluator must be a string";
      return false;
    }
  }
  out->maxLengthChars = jsonInt(root.field("maxLengthChars"), out->maxLengthChars);
  if (const JsonVal *v = root.field("sentenceBoundary")) {
    if (v->type == JsonVal::Bool) out->sentenceBoundary = v->b;
  }
  if (const JsonVal *v = root.field("sentenceBoundaryChars")) {
    if (v->type == JsonVal::Null) {
      // keep default
    } else if (v->type != JsonVal::Array) {
      if (error) *error = "sentenceBoundaryChars must be an array of strings";
      return false;
    } else {
      out->sentenceBoundaryChars.clear();
      for (const auto &item : v->a) {
        if (item.type != JsonVal::String) {
          if (error) *error = "sentenceBoundaryChars must only contain strings";
          return false;
        }
        if (!item.s.empty()) out->sentenceBoundaryChars.push_back(item.s);
      }
    }
  }
  out->silenceThresholdMs = jsonInt(root.field("silenceThresholdMs"), out->silenceThresholdMs);
  out->energyThresholdDb = jsonDouble(root.field("energyThresholdDb"), out->energyThresholdDb);
  out->minSegmentMs = jsonInt(root.field("minSegmentMs"), out->minSegmentMs);
  out->maxSegmentMs = jsonInt(root.field("maxSegmentMs"), out->maxSegmentMs);
  out->hangoverMs = jsonInt(root.field("hangoverMs"), out->hangoverMs);
  out->checkpointIntervalMs = jsonInt(root.field("checkpointIntervalMs"), out->checkpointIntervalMs);
  if (const JsonVal *v = root.field("punctuationInstanceId")) {
    if (v->type == JsonVal::String) out->punctuationInstanceId = v->s;
  }
  if (const JsonVal *v = root.field("modelPath")) {
    if (v->type == JsonVal::String) out->modelPath = v->s;
    else if (v->type == JsonVal::Object) {
      if (const JsonVal *path = v->field("path")) {
        if (path->type == JsonVal::String) out->modelPath = path->s;
      }
    }
  }
  if (const JsonVal *v = root.field("modelType")) {
    if (v->type == JsonVal::String) out->modelType = v->s;
  }
  out->vadThreshold = jsonDouble(root.field("vadThreshold"), out->vadThreshold);
  out->vadMinSpeechMs = jsonInt(root.field("vadMinSpeechMs"), out->vadMinSpeechMs);
  out->vadMinSilenceMs = jsonInt(root.field("vadMinSilenceMs"), out->vadMinSilenceMs);
  out->windowShiftRatio = jsonDouble(root.field("windowShiftRatio"), out->windowShiftRatio);
  out->minDurationOn = jsonDouble(root.field("minDurationOn"), out->minDurationOn);
  out->minDurationOff = jsonDouble(root.field("minDurationOff"), out->minDurationOff);
  return true;
}

std::string policyToJson(const SegEnginePolicy &p) {
  std::string j = "{";
  j += "\"evaluator\":\"" + jsonEscape(p.evaluator) + "\"";
  j += ",\"maxLengthChars\":" + std::to_string(p.maxLengthChars);
  j += std::string(",\"sentenceBoundary\":") + (p.sentenceBoundary ? "true" : "false");
  if (!p.sentenceBoundaryChars.empty()) {
    j += ",\"sentenceBoundaryChars\":[";
    for (size_t i = 0; i < p.sentenceBoundaryChars.size(); ++i) {
      if (i) j += ",";
      j += "\"" + jsonEscape(p.sentenceBoundaryChars[i]) + "\"";
    }
    j += "]";
  }
  j += ",\"silenceThresholdMs\":" + std::to_string(p.silenceThresholdMs);
  j += ",\"energyThresholdDb\":" + std::to_string(p.energyThresholdDb);
  j += ",\"minSegmentMs\":" + std::to_string(p.minSegmentMs);
  j += ",\"maxSegmentMs\":" + std::to_string(p.maxSegmentMs);
  j += ",\"hangoverMs\":" + std::to_string(p.hangoverMs);
  j += ",\"checkpointIntervalMs\":" + std::to_string(p.checkpointIntervalMs);
  j += ",\"punctuationInstanceId\":\"" + jsonEscape(p.punctuationInstanceId) + "\"";
  j += ",\"modelPath\":\"" + jsonEscape(p.modelPath) + "\"";
  j += ",\"modelType\":\"" + jsonEscape(p.modelType) + "\"";
  j += ",\"vadThreshold\":" + std::to_string(p.vadThreshold);
  j += ",\"vadMinSpeechMs\":" + std::to_string(p.vadMinSpeechMs);
  j += ",\"vadMinSilenceMs\":" + std::to_string(p.vadMinSilenceMs);
  j += ",\"windowShiftRatio\":" + std::to_string(p.windowShiftRatio);
  j += ",\"minDurationOn\":" + std::to_string(p.minDurationOn);
  j += ",\"minDurationOff\":" + std::to_string(p.minDurationOff);
  j += "}";
  return j;
}

std::string infoToJson(const SegEngineInfoSnapshot &info) {
  std::string j = "{\"engineId\":\"" + jsonEscape(info.engineId) + "\"";
  j += ",\"attachedBufferId\":\"" + jsonEscape(info.attachedBufferId) + "\"";
  j += ",\"domain\":\"" + jsonEscape(info.domain) + "\"";
  j += ",\"state\":\"" + jsonEscape(info.state) + "\"";
  j += ",\"totalSegmentsCommitted\":" + std::to_string(info.totalSegmentsCommitted);
  j += ",\"lastSegmentId\":\"" + jsonEscape(info.lastSegmentId) + "\"";
  j += ",\"segmentBufferId\":\"" + jsonEscape(info.segmentBufferId) + "\"";
  j += ",\"policy\":" + policyToJson(info.policy);
  j += "}";
  return j;
}

std::string okInfo(const SegEngineInfoSnapshot &info) {
  return std::string("{\"ok\":true,\"info\":") + infoToJson(info) + "}";
}

std::string failJson(const std::string &code, const std::string &message) {
  std::string msg = message;
  const std::string prefix = code + ": ";
  if (!code.empty() && msg.compare(0, prefix.size(), prefix) == 0) {
    msg = msg.substr(prefix.size());
  }
  return std::string("{\"ok\":false,\"code\":\"") + jsonEscape(code) + "\",\"message\":\"" +
         jsonEscape(msg) + "\"}";
}

std::string messageOnly(const std::string &code, const std::string &error) {
  const std::string prefix = code + ": ";
  if (!code.empty() && error.compare(0, prefix.size(), prefix) == 0) {
    return error.substr(prefix.size());
  }
  return error;
}

bool ensureBridge(JNIEnv *env) {
  if (g_emit_from_native && g_bridge_class) return true;
  if (!g_vm) {
    env->GetJavaVM(&g_vm);
  }
  jclass local = env->FindClass("com/sherpaonnx/segment/pipeline/SegmentBufferEventBridge");
  if (!local) {
    if (env->ExceptionCheck()) env->ExceptionClear();
    __android_log_print(ANDROID_LOG_ERROR, SEG_ENGINE_JNI_TAG,
                        "FindClass SegmentBufferEventBridge failed");
    return false;
  }
  g_bridge_class = static_cast<jclass>(env->NewGlobalRef(local));
  env->DeleteLocalRef(local);
  if (!g_bridge_class) return false;
  g_emit_from_native = env->GetStaticMethodID(
      g_bridge_class, "emitFromNative",
      "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;IILjava/lang/String;IIIIZDLjava/"
      "lang/String;)V");
  if (!g_emit_from_native) {
    if (env->ExceptionCheck()) env->ExceptionClear();
    __android_log_print(ANDROID_LOG_ERROR, SEG_ENGINE_JNI_TAG, "GetStaticMethodID emitFromNative failed");
    return false;
  }
  return true;
}

void emitAppended(const std::string &bufferId, const SegRecord &rec, int segmentIndex,
                  int totalSegments) {
  if (!g_vm) return;
  JNIEnv *env = nullptr;
  bool attached = false;
  const jint got = g_vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6);
  if (got == JNI_EDETACHED) {
    if (g_vm->AttachCurrentThread(&env, nullptr) != JNI_OK || !env) return;
    attached = true;
  } else if (got != JNI_OK || !env) {
    return;
  }
  if (!ensureBridge(env)) {
    if (attached) g_vm->DetachCurrentThread();
    return;
  }
  jstring jBuffer = sherpaonnx::NewJStringUtf8(env, bufferId);
  jstring jId = sherpaonnx::NewJStringUtf8(env, rec.id);
  jstring jKind = sherpaonnx::NewJStringUtf8(env, rec.kind);
  jstring jSrc = sherpaonnx::NewJStringUtf8(env, rec.sourceAudioBufferId);
  jstring jPayload = sherpaonnx::NewJStringUtf8(env, rec.payloadJson);
  if (jBuffer && jId && jKind && jSrc && jPayload) {
    env->CallStaticVoidMethod(g_bridge_class, g_emit_from_native, jBuffer, jId, jKind, segmentIndex,
                              totalSegments, jSrc, rec.startSample, rec.endSample, rec.sampleRate,
                              rec.durationMs, rec.hasConfidence ? JNI_TRUE : JNI_FALSE,
                              rec.confidence, jPayload);
    if (env->ExceptionCheck()) {
      env->ExceptionDescribe();
      env->ExceptionClear();
    }
  }
  if (jBuffer) env->DeleteLocalRef(jBuffer);
  if (jId) env->DeleteLocalRef(jId);
  if (jKind) env->DeleteLocalRef(jKind);
  if (jSrc) env->DeleteLocalRef(jSrc);
  if (jPayload) env->DeleteLocalRef(jPayload);
  if (attached) g_vm->DetachCurrentThread();
}

void installSpeechEmitter(const std::string &segmentBufferId) {
  if (segmentBufferId.empty()) return;
  auto entry = seg_get_live_entry(segmentBufferId);
  if (!entry) return;
  entry->segmentAppendedEmitter = emitAppended;
}

std::string offlineResultJson(bool textDomain, const std::string &sourceBufferId,
                              const std::string &outBufferId, int segmentCount,
                              const std::vector<SegOfflineTextSegment> &segments) {
  std::string j = "{\"ok\":true,\"bufferId\":\"" +
                  jsonEscape(textDomain ? sourceBufferId : outBufferId) + "\"";
  j += std::string(",\"kind\":\"") + (textDomain ? "offlineTextBuffer" : "offlineSegmentBuffer") +
       "\"";
  j += ",\"state\":\"immutable\"";
  j += ",\"segmentCount\":" + std::to_string(segmentCount);
  if (!textDomain) {
    j += ",\"sourceAudioBufferId\":\"" + jsonEscape(sourceBufferId) + "\"";
  }
  if (textDomain) {
    j += ",\"segments\":[";
    for (size_t i = 0; i < segments.size(); ++i) {
      const auto &s = segments[i];
      if (i) j += ",";
      j += "{\"segmentId\":\"" + jsonEscape(s.segmentId) + "\"";
      j += ",\"startOffset\":" + std::to_string(s.startOffset);
      j += ",\"endOffset\":" + std::to_string(s.endOffset);
      j += ",\"reason\":\"" + jsonEscape(s.reason) + "\"";
      j += ",\"source\":\"" + jsonEscape(s.source) + "\"";
      j += ",\"text\":\"" + jsonEscape(s.text) + "\"}";
    }
    j += "]";
  }
  j += "}";
  return j;
}

}  // namespace

extern "C" {

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_segment_engine_SegmentationEngineNative_nativeAttach(JNIEnv *env, jclass,
                                                                        jstring bufferId,
                                                                        jstring domain,
                                                                        jstring policyJson) {
  env->GetJavaVM(&g_vm);
  ensureBridge(env);
  SegEnginePolicy policy;
  std::string policyError;
  if (!policyFromJson(jstringToUtf8(env, policyJson), &policy, &policyError)) {
    return utf8ToJstring(env, failJson("POLICY_INVALID", policyError));
  }
  SegEngineInfoSnapshot info;
  std::string code;
  std::string error;
  if (!seg_engine_attach(jstringToUtf8(env, bufferId), jstringToUtf8(env, domain), policy, &info,
                         &code, &error)) {
    return utf8ToJstring(env, failJson(code.empty() ? "SEGMENT_INTERNAL_ERROR" : code,
                                       error.empty() ? "attach failed" : error));
  }
  installSpeechEmitter(info.segmentBufferId);
  return utf8ToJstring(env, okInfo(info));
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_segment_engine_SegmentationEngineNative_nativeDetach(JNIEnv *env, jclass,
                                                                        jstring engineId,
                                                                        jboolean flushFinal) {
  std::string error;
  if (!seg_engine_detach(jstringToUtf8(env, engineId), flushFinal == JNI_TRUE, &error)) {
    std::string code = "ENGINE_DETACHED";
    const auto colon = error.find(':');
    if (colon != std::string::npos && colon > 0) code = error.substr(0, colon);
    return utf8ToJstring(env, failJson(code, messageOnly(code, error)));
  }
  return utf8ToJstring(env, "{\"ok\":true}");
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_segment_engine_SegmentationEngineNative_nativeGetInfo(JNIEnv *env, jclass,
                                                                         jstring engineId) {
  SegEngineInfoSnapshot info;
  std::string code;
  std::string error;
  if (!seg_engine_get_info(jstringToUtf8(env, engineId), &info, &code, &error)) {
    return utf8ToJstring(env, failJson(code.empty() ? "ENGINE_DETACHED" : code,
                                       error.empty() ? "engine not found" : error));
  }
  return utf8ToJstring(env, okInfo(info));
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_segment_engine_SegmentationEngineNative_nativeSegmentOffline(
    JNIEnv *env, jclass, jstring bufferId, jstring domain, jstring policyJson) {
  SegEnginePolicy policy;
  std::string policyError;
  if (!policyFromJson(jstringToUtf8(env, policyJson), &policy, &policyError)) {
    return utf8ToJstring(env, failJson("POLICY_INVALID", policyError));
  }
  const std::string bid = jstringToUtf8(env, bufferId);
  const std::string domainRaw = jstringToUtf8(env, domain);
  std::vector<SegOfflineTextSegment> segments;
  std::string outId;
  int count = 0;
  std::string code;
  std::string error;
  if (!seg_engine_segment_offline(bid, domainRaw, policy, &segments, &outId, &count, &code,
                                  &error)) {
    return utf8ToJstring(env, failJson(code.empty() ? "SEGMENT_INTERNAL_ERROR" : code,
                                       error.empty() ? "segment offline failed" : error));
  }
  std::string domainLower = domainRaw;
  for (char &c : domainLower) {
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  }
  return utf8ToJstring(env, offlineResultJson(domainLower == "text", bid, outId, count, segments));
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_segment_engine_SegmentationEngineNative_nativeFlush(JNIEnv *env, jclass,
                                                                       jstring engineId) {
  std::string error;
  seg_engine_flush(jstringToUtf8(env, engineId), &error);
  return utf8ToJstring(env, "{\"ok\":true}");
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_segment_engine_SegmentationEngineNative_nativePeekAnnotation(JNIEnv *env,
                                                                                jclass,
                                                                                jstring segmentId) {
  std::string reason;
  std::string source;
  int64_t createdAtMs = 0;
  int segmentIndex = 0;
  if (!seg_engine_peek_annotation(jstringToUtf8(env, segmentId), &reason, &source, &createdAtMs,
                                  &segmentIndex)) {
    return utf8ToJstring(env, "{\"found\":false}");
  }
  std::string j = "{\"found\":true,\"reason\":\"" + jsonEscape(reason) + "\"";
  j += ",\"source\":\"" + jsonEscape(source) + "\"";
  j += ",\"createdAtMs\":" + std::to_string(createdAtMs);
  j += ",\"segmentIndex\":" + std::to_string(segmentIndex);
  j += "}";
  return utf8ToJstring(env, j);
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_segment_engine_SegmentationEngineNative_nativeRecordAnnotation(
    JNIEnv *env, jclass, jstring segmentId, jstring reason, jstring source, jlong createdAtMs,
    jint segmentIndex) {
  seg_engine_record_annotation(jstringToUtf8(env, segmentId), jstringToUtf8(env, reason),
                               jstringToUtf8(env, source), static_cast<int64_t>(createdAtMs),
                               static_cast<int>(segmentIndex));
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_segment_engine_SegmentationEngineNative_nativeReleaseAll(JNIEnv *, jclass) {
  seg_engine_release_all();
}

}  // extern "C"
