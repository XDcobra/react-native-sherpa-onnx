/**
 * sherpa_onnx_ctc_alignment.cpp — shared CTC alignment core (ORT C API).
 */
#if defined(__linux__) && !defined(__ANDROID__)
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#endif

#include "sherpa_onnx_ctc_alignment.hpp"

#include <algorithm>
#include <climits>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <cwctype>
#include <locale.h>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#if defined(__ANDROID__) || defined(__APPLE__)
#include <xlocale.h>
#elif defined(__linux__)
#include <locale.h>
#endif

#if defined(__has_include)
#if __has_include(<onnxruntime/core/session/onnxruntime_c_api.h>)
#include <onnxruntime/core/session/onnxruntime_c_api.h>
#define SHERPA_ONNX_HAS_ORT_C_API 1
#endif
#endif

namespace sherpa_onnx {
namespace ctc_alignment {
namespace {

#if defined(SHERPA_ONNX_HAS_ORT_C_API)

static void CheckOrtStatus(const OrtApi* api, OrtStatus* status, const char* prefix) {
  if (status == nullptr) {
    return;
  }
  std::string message(prefix);
  message += ": ";
  message += api->GetErrorMessage(status);
  api->ReleaseStatus(status);
  throw std::runtime_error(message);
}

static const OrtApi* ResolveOrtApiForAlignment() {
  const OrtApiBase* base = OrtGetApiBase();
  if (base == nullptr) {
    throw std::runtime_error(
        "ONNX Runtime is not available (OrtGetApiBase returned null). "
        "Subtitle-accurate alignment requires ONNX Runtime.");
  }
  const char* rtVersion = "unknown";
  if (base->GetVersionString != nullptr) {
    rtVersion = base->GetVersionString();
  }
  constexpr uint32_t kMinOrtApiVersion = 17;
  for (uint32_t ver = ORT_API_VERSION; ver >= kMinOrtApiVersion; --ver) {
    const OrtApi* api = base->GetApi(ver);
    if (api != nullptr && api->CreateEnv != nullptr && api->CreateSession != nullptr) {
      return api;
    }
  }
  std::ostringstream oss;
  oss << "ONNX Runtime API mismatch: GetApi() returned null for API " << ORT_API_VERSION << " down to "
      << kMinOrtApiVersion << ". Runtime version string: " << rtVersion;
  throw std::runtime_error(oss.str());
}

#endif  // SHERPA_ONNX_HAS_ORT_C_API

static locale_t AcquireEnUsUtf8Locale() {
  static locale_t loc = nullptr;
  if (loc == nullptr) {
    loc = newlocale(LC_CTYPE_MASK, "en_US.UTF-8", static_cast<locale_t>(0));
    if (loc == nullptr) {
      loc = newlocale(LC_CTYPE_MASK, "C.UTF-8", static_cast<locale_t>(0));
    }
    if (loc == nullptr) {
      loc = newlocale(LC_CTYPE_MASK, "C", static_cast<locale_t>(0));
    }
  }
  return loc;
}

static char32_t UpperCodePointEnUs(char32_t cp) {
  locale_t L = AcquireEnUsUtf8Locale();
  if (cp <= 0xFFFFu) {
    wint_t w = towupper_l(static_cast<wint_t>(cp), L);
    if (w != static_cast<wint_t>(WEOF)) {
      return static_cast<char32_t>(w);
    }
  }
  return cp;
}

static bool IsUnicodeWhitespace(char32_t c) {
  if (c <= 0xFFu) {
    if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == 0x0Bu || c == 0x0Cu) {
      return true;
    }
    if (c == 0x85u) {
      return true;
    }
    return false;
  }
  if (c == 0x00A0 || c == 0x1680 || c == 0x202F || c == 0x205F || c == 0x3000) {
    return true;
  }
  if (c >= 0x2000 && c <= 0x200A) {
    return true;
  }
  if (c == 0x2028 || c == 0x2029) {
    return true;
  }
  return false;
}

static bool Utf8DecodeOne(const std::string& s, size_t& i, char32_t& out) {
  const unsigned char* p = reinterpret_cast<const unsigned char*>(s.data());
  const size_t n = s.size();
  if (i >= n) {
    return false;
  }
  const unsigned char c0 = p[i];
  if (c0 < 0x80u) {
    out = c0;
    i += 1;
    return true;
  }
  if ((c0 & 0xE0u) == 0xC0u && i + 1 < n) {
    const unsigned char c1 = p[i + 1];
    if ((c1 & 0xC0u) != 0x80u) {
      return false;
    }
    out = (static_cast<char32_t>(c0 & 0x1Fu) << 6) | static_cast<char32_t>(c1 & 0x3Fu);
    i += 2;
    return true;
  }
  if ((c0 & 0xF0u) == 0xE0u && i + 2 < n) {
    const unsigned char c1 = p[i + 1];
    const unsigned char c2 = p[i + 2];
    if ((c1 & 0xC0u) != 0x80u || (c2 & 0xC0u) != 0x80u) {
      return false;
    }
    out = (static_cast<char32_t>(c0 & 0x0Fu) << 12) | (static_cast<char32_t>(c1 & 0x3Fu) << 6) |
          static_cast<char32_t>(c2 & 0x3Fu);
    i += 3;
    return true;
  }
  if ((c0 & 0xF8u) == 0xF0u && i + 3 < n) {
    const unsigned char c1 = p[i + 1];
    const unsigned char c2 = p[i + 2];
    const unsigned char c3 = p[i + 3];
    if ((c1 & 0xC0u) != 0x80u || (c2 & 0xC0u) != 0x80u || (c3 & 0xC0u) != 0x80u) {
      return false;
    }
    out = (static_cast<char32_t>(c0 & 0x07u) << 18) | (static_cast<char32_t>(c1 & 0x3Fu) << 12) |
          (static_cast<char32_t>(c2 & 0x3Fu) << 6) | static_cast<char32_t>(c3 & 0x3Fu);
    i += 4;
    return true;
  }
  return false;
}

static void Utf8Append(std::string& s, char32_t cp) {
  if (cp < 0x80u) {
    s.push_back(static_cast<char>(cp));
    return;
  }
  if (cp < 0x800u) {
    s.push_back(static_cast<char>(0xC0u | ((cp >> 6) & 0x1Fu)));
    s.push_back(static_cast<char>(0x80u | (cp & 0x3Fu)));
    return;
  }
  if (cp < 0x10000u) {
    s.push_back(static_cast<char>(0xE0u | ((cp >> 12) & 0x0Fu)));
    s.push_back(static_cast<char>(0x80u | ((cp >> 6) & 0x3Fu)));
    s.push_back(static_cast<char>(0x80u | (cp & 0x3Fu)));
    return;
  }
  s.push_back(static_cast<char>(0xF0u | ((cp >> 18) & 0x07u)));
  s.push_back(static_cast<char>(0x80u | ((cp >> 12) & 0x3Fu)));
  s.push_back(static_cast<char>(0x80u | ((cp >> 6) & 0x3Fu)));
  s.push_back(static_cast<char>(0x80u | (cp & 0x3Fu)));
}

static std::string Utf8UpperEnUs(const std::string& utf8) {
  std::string out;
  out.reserve(utf8.size());
  size_t i = 0;
  while (i < utf8.size()) {
    char32_t cp = 0;
    if (!Utf8DecodeOne(utf8, i, cp)) {
      throw std::runtime_error("Invalid UTF-8 in alignment text");
    }
    Utf8Append(out, UpperCodePointEnUs(cp));
  }
  return out;
}

static std::unordered_map<std::string, int32_t> ParseVocabJson(const std::string& json) {
  std::unordered_map<std::string, int32_t> vocab;
  size_t i = 0;
  auto is_space = [](char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; };
  auto skip_ws = [&]() {
    while (i < json.size() && is_space(json[i])) {
      ++i;
    }
  };
  skip_ws();
  if (i >= json.size() || json[i] != '{') {
    throw std::runtime_error("Vocabulary JSON must be an object");
  }
  ++i;
  while (true) {
    skip_ws();
    if (i < json.size() && json[i] == '}') {
      ++i;
      break;
    }
    if (i >= json.size() || json[i] != '"') {
      throw std::runtime_error("Vocabulary JSON: expected string key");
    }
    ++i;
    std::string key;
    while (i < json.size()) {
      char c = json[i];
      if (c == '"') {
        ++i;
        break;
      }
      if (c == '\\' && i + 1 < json.size()) {
        key.push_back(json[i + 1]);
        i += 2;
        continue;
      }
      key.push_back(c);
      ++i;
    }
    skip_ws();
    if (i >= json.size() || json[i] != ':') {
      throw std::runtime_error("Vocabulary JSON: expected ':'");
    }
    ++i;
    skip_ws();
    bool neg = false;
    if (i < json.size() && json[i] == '-') {
      neg = true;
      ++i;
    }
    if (i >= json.size() || json[i] < '0' || json[i] > '9') {
      throw std::runtime_error("Vocabulary JSON: expected integer value");
    }
    int64_t val = 0;
    while (i < json.size() && json[i] >= '0' && json[i] <= '9') {
      val = val * 10 + (json[i] - '0');
      ++i;
    }
    if (neg) {
      val = -val;
    }
    if (val < INT32_MIN || val > INT32_MAX) {
      throw std::runtime_error("Vocabulary JSON: id out of range");
    }
    if (!key.empty()) {
      vocab[key] = static_cast<int32_t>(val);
    }
    skip_ws();
    if (i < json.size() && json[i] == ',') {
      ++i;
      continue;
    }
    skip_ws();
    if (i < json.size() && json[i] == '}') {
      ++i;
      break;
    }
    throw std::runtime_error("Vocabulary JSON: expected ',' or '}'");
  }
  if (vocab.empty()) {
    throw std::runtime_error("Vocabulary JSON has no valid entries");
  }
  return vocab;
}

static std::vector<std::string> BuildTokenTexts(
    const std::string& text,
    const std::unordered_map<std::string, int32_t>& vocab,
    int32_t wordBoundaryId) {
  const std::string uppercase = Utf8UpperEnUs(text);
  std::vector<std::string> tokens;
  size_t idx = 0;
  while (idx < uppercase.size()) {
    char32_t c = 0;
    if (!Utf8DecodeOne(uppercase, idx, c)) {
      throw std::runtime_error("Invalid UTF-8 after uppercasing alignment text");
    }
    if (IsUnicodeWhitespace(c)) {
      if (!tokens.empty() && tokens.back() != "|") {
        tokens.push_back("|");
      }
      continue;
    }
    char32_t normalized = c;
    if (c == 0x2019u || c == 0x0060u || c == 0x00B4u) {
      normalized = '\'';
    }
    std::string token;
    Utf8Append(token, normalized);
    if (vocab.find(token) != vocab.end()) {
      tokens.push_back(std::move(token));
    }
  }
  while (!tokens.empty() && tokens.front() == "|") {
    tokens.erase(tokens.begin());
  }
  while (!tokens.empty() && tokens.back() == "|") {
    tokens.pop_back();
  }
  auto boundaryIt = vocab.find("|");
  if (boundaryIt == vocab.end() || boundaryIt->second != wordBoundaryId) {
    tokens.erase(std::remove(tokens.begin(), tokens.end(), "|"), tokens.end());
  }
  return tokens;
}

static std::vector<float> ResampleLinear(
    const std::vector<float>& input,
    int32_t sourceSampleRate,
    int32_t targetSampleRate) {
  if (input.empty() || sourceSampleRate <= 0 || targetSampleRate <= 0) {
    return {};
  }
  if (sourceSampleRate == targetSampleRate) {
    return input;
  }
  size_t outputLength = std::max<size_t>(
      1,
      static_cast<size_t>(std::floor(static_cast<double>(input.size()) * targetSampleRate / sourceSampleRate)));
  std::vector<float> output(outputLength, 0.0f);
  const double ratio = static_cast<double>(sourceSampleRate) / targetSampleRate;
  for (size_t i = 0; i < outputLength; ++i) {
    double srcPos = static_cast<double>(i) * ratio;
    size_t left = static_cast<size_t>(std::floor(srcPos));
    size_t right = std::min(left + 1, input.size() - 1);
    double frac = srcPos - static_cast<double>(left);
    float leftVal = input[std::min(left, input.size() - 1)];
    float rightVal = input[right];
    output[i] = static_cast<float>(leftVal + (rightVal - leftVal) * frac);
  }
  return output;
}

static std::vector<float> NormalizeAudio(const std::vector<float>& input) {
  if (input.empty()) {
    return input;
  }
  double sum = 0.0;
  for (float v : input) {
    sum += v;
  }
  const double mean = sum / input.size();
  double variance = 0.0;
  for (float v : input) {
    const double centered = v - mean;
    variance += centered * centered;
  }
  variance /= input.size();
  const double stdv = std::sqrt(std::max(variance, 1e-12));
  std::vector<float> out(input.size(), 0.0f);
  for (size_t i = 0; i < input.size(); ++i) {
    out[i] = static_cast<float>((input[i] - mean) / stdv);
  }
  return out;
}

static std::vector<std::vector<float>> LogSoftmax(
    const std::vector<float>& logitsFlat,
    int32_t frames,
    int32_t vocabSize) {
  if (frames <= 0 || vocabSize <= 0) {
    return {};
  }
  std::vector<std::vector<float>> out(frames, std::vector<float>(vocabSize, 0.0f));
  for (int32_t t = 0; t < frames; ++t) {
    int32_t rowOffset = t * vocabSize;
    float rowMax = -INFINITY;
    for (int32_t v = 0; v < vocabSize; ++v) {
      rowMax = std::max(rowMax, logitsFlat[rowOffset + v]);
    }
    double sumExp = 0.0;
    for (int32_t v = 0; v < vocabSize; ++v) {
      sumExp += std::exp(static_cast<double>(logitsFlat[rowOffset + v] - rowMax));
    }
    double logDenom = rowMax + std::log(std::max(sumExp, 1e-12));
    for (int32_t v = 0; v < vocabSize; ++v) {
      out[t][v] = static_cast<float>(logitsFlat[rowOffset + v] - logDenom);
    }
  }
  return out;
}

#if defined(SHERPA_ONNX_HAS_ORT_C_API)

static std::vector<std::vector<float>> RunOrtInference(
    const std::string& modelPath,
    const std::vector<float>& samples) {
  const OrtApi* api = ResolveOrtApiForAlignment();
  OrtEnv* env = nullptr;
  OrtSessionOptions* sessionOptions = nullptr;
  OrtSession* session = nullptr;
  OrtAllocator* allocator = nullptr;
  OrtMemoryInfo* memoryInfo = nullptr;
  OrtValue* inputTensor = nullptr;
  OrtValue* outputTensor = nullptr;
  OrtTensorTypeAndShapeInfo* shapeInfo = nullptr;
  char* inputName = nullptr;
  char* outputName = nullptr;

  auto cleanup = [&]() {
    if (shapeInfo != nullptr) {
      api->ReleaseTensorTypeAndShapeInfo(shapeInfo);
    }
    shapeInfo = nullptr;
    if (outputTensor != nullptr) {
      api->ReleaseValue(outputTensor);
    }
    outputTensor = nullptr;
    if (inputTensor != nullptr) {
      api->ReleaseValue(inputTensor);
    }
    inputTensor = nullptr;
    if (memoryInfo != nullptr) {
      api->ReleaseMemoryInfo(memoryInfo);
    }
    memoryInfo = nullptr;
    if (inputName != nullptr && allocator != nullptr) {
      (void)api->AllocatorFree(allocator, inputName);
    }
    inputName = nullptr;
    if (outputName != nullptr && allocator != nullptr) {
      (void)api->AllocatorFree(allocator, outputName);
    }
    outputName = nullptr;
    if (session != nullptr) {
      api->ReleaseSession(session);
    }
    session = nullptr;
    if (sessionOptions != nullptr) {
      api->ReleaseSessionOptions(sessionOptions);
    }
    sessionOptions = nullptr;
    if (env != nullptr) {
      api->ReleaseEnv(env);
    }
    env = nullptr;
  };

  try {
    CheckOrtStatus(api, api->CreateEnv(ORT_LOGGING_LEVEL_WARNING, "sherpa-onnx-ctc-align", &env), "CreateEnv failed");
    CheckOrtStatus(api, api->CreateSessionOptions(&sessionOptions), "CreateSessionOptions failed");
    CheckOrtStatus(api, api->CreateSession(env, modelPath.c_str(), sessionOptions, &session), "CreateSession failed");
    CheckOrtStatus(api, api->GetAllocatorWithDefaultOptions(&allocator), "GetAllocatorWithDefaultOptions failed");

    size_t inputCount = 0;
    size_t outputCount = 0;
    CheckOrtStatus(api, api->SessionGetInputCount(session, &inputCount), "SessionGetInputCount failed");
    CheckOrtStatus(api, api->SessionGetOutputCount(session, &outputCount), "SessionGetOutputCount failed");
    if (inputCount == 0 || outputCount == 0) {
      throw std::runtime_error("Alignment model has no inputs/outputs");
    }
    CheckOrtStatus(api, api->SessionGetInputName(session, 0, allocator, &inputName), "SessionGetInputName failed");
    CheckOrtStatus(api, api->SessionGetOutputName(session, 0, allocator, &outputName), "SessionGetOutputName failed");
    CheckOrtStatus(
        api,
        api->CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, &memoryInfo),
        "CreateCpuMemoryInfo failed");

    int64_t inputShape[2] = {1, static_cast<int64_t>(samples.size())};
    CheckOrtStatus(
        api,
        api->CreateTensorWithDataAsOrtValue(
            memoryInfo,
            const_cast<float*>(samples.data()),
            samples.size() * sizeof(float),
            inputShape,
            2,
            ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT,
            &inputTensor),
        "CreateTensorWithDataAsOrtValue failed");

    const char* inputNames[] = {inputName};
    const char* outputNames[] = {outputName};
    const OrtValue* inputValues[] = {inputTensor};
    CheckOrtStatus(
        api,
        api->Run(session, nullptr, inputNames, inputValues, 1, outputNames, 1, &outputTensor),
        "Run failed");

    CheckOrtStatus(api, api->GetTensorTypeAndShape(outputTensor, &shapeInfo), "GetTensorTypeAndShape failed");
    size_t dimCount = 0;
    CheckOrtStatus(api, api->GetDimensionsCount(shapeInfo, &dimCount), "GetDimensionsCount failed");
    std::vector<int64_t> dims(dimCount, 0);
    if (dimCount > 0) {
      CheckOrtStatus(api, api->GetDimensions(shapeInfo, dims.data(), dimCount), "GetDimensions failed");
    }
    size_t elementCount = 0;
    CheckOrtStatus(api, api->GetTensorShapeElementCount(shapeInfo, &elementCount), "GetTensorShapeElementCount failed");
    if (elementCount == 0) {
      throw std::runtime_error("Model output tensor is empty");
    }
    float* logitsData = nullptr;
    CheckOrtStatus(api, api->GetTensorMutableData(outputTensor, reinterpret_cast<void**>(&logitsData)), "GetTensorMutableData failed");
    std::vector<float> logitsFlat(logitsData, logitsData + elementCount);

    int32_t frames = 1;
    int32_t vocabSize = static_cast<int32_t>(elementCount);
    if (dims.size() >= 3) {
      frames = std::max<int32_t>(1, static_cast<int32_t>(dims[1]));
      vocabSize = std::max<int32_t>(1, static_cast<int32_t>(dims[2]));
    } else if (dims.size() == 2) {
      frames = std::max<int32_t>(1, static_cast<int32_t>(dims[0]));
      vocabSize = std::max<int32_t>(1, static_cast<int32_t>(dims[1]));
    }
    frames = std::max<int32_t>(1, std::min<int32_t>(frames, static_cast<int32_t>(elementCount)));
    vocabSize = std::max<int32_t>(1, std::min<int32_t>(vocabSize, static_cast<int32_t>(elementCount / frames)));

    std::vector<std::vector<float>> logProbs = LogSoftmax(logitsFlat, frames, vocabSize);
    cleanup();
    return logProbs;
  } catch (...) {
    cleanup();
    throw;
  }
}

#endif  // SHERPA_ONNX_HAS_ORT_C_API

struct ExpandedTarget {
  std::vector<int32_t> ids;
  std::vector<int32_t> tokenIndices;
};

static ExpandedTarget BuildExpandedTarget(const std::vector<int32_t>& tokenIds, int32_t blankId) {
  ExpandedTarget target;
  target.ids.reserve(tokenIds.size() * 2 + 1);
  target.tokenIndices.reserve(tokenIds.size() * 2 + 1);
  target.ids.push_back(blankId);
  target.tokenIndices.push_back(-1);
  for (size_t i = 0; i < tokenIds.size(); ++i) {
    target.ids.push_back(tokenIds[i]);
    target.tokenIndices.push_back(static_cast<int32_t>(i));
    target.ids.push_back(blankId);
    target.tokenIndices.push_back(-1);
  }
  return target;
}

static float SafeLogProb(const std::vector<float>& row, int32_t tokenId) {
  if (tokenId < 0 || tokenId >= static_cast<int32_t>(row.size())) {
    return -1.0e30f;
  }
  return row[tokenId];
}

static std::vector<int32_t> CtcBacktrack(
    const std::vector<std::vector<float>>& logProbs,
    const std::vector<int32_t>& expandedTarget,
    int32_t blankId) {
  const int32_t T = static_cast<int32_t>(logProbs.size());
  const int32_t S = static_cast<int32_t>(expandedTarget.size());
  if (T <= 0 || S <= 0) {
    return {};
  }
  const float kNegInf = -1.0e30f;
  std::vector<std::vector<float>> trellis(T, std::vector<float>(S, kNegInf));
  trellis[0][0] = SafeLogProb(logProbs[0], expandedTarget[0]);
  if (S > 1) {
    trellis[0][1] = SafeLogProb(logProbs[0], expandedTarget[1]);
  }
  for (int32_t t = 1; t < T; ++t) {
    for (int32_t s = 0; s < S; ++s) {
      float best = trellis[t - 1][s];
      if (s > 0) {
        best = std::max(best, trellis[t - 1][s - 1]);
      }
      if (s > 1 && expandedTarget[s] != blankId && expandedTarget[s] != expandedTarget[s - 2]) {
        best = std::max(best, trellis[t - 1][s - 2]);
      }
      if (best <= kNegInf / 2) {
        trellis[t][s] = kNegInf;
      } else {
        trellis[t][s] = best + SafeLogProb(logProbs[t], expandedTarget[s]);
      }
    }
  }
  int32_t state = (S > 1 && trellis[T - 1][S - 2] > trellis[T - 1][S - 1]) ? (S - 2) : (S - 1);
  std::vector<int32_t> path(T, 0);
  path[T - 1] = state;
  for (int32_t t = T - 1; t > 0; --t) {
    int32_t bestState = state;
    float bestScore = trellis[t - 1][state];
    if (state > 0 && trellis[t - 1][state - 1] > bestScore) {
      bestScore = trellis[t - 1][state - 1];
      bestState = state - 1;
    }
    if (state > 1 && expandedTarget[state] != blankId && expandedTarget[state] != expandedTarget[state - 2]) {
      if (trellis[t - 1][state - 2] > bestScore) {
        bestState = state - 2;
      }
    }
    state = bestState;
    path[t - 1] = state;
  }
  return path;
}

}  // namespace

CtcAlignmentResult RunCtcAlignmentFromFloatPcm(
    const std::string& model_path,
    const std::string& text_utf8,
    const std::string& vocab_json_utf8,
    const float* samples,
    size_t sample_count,
    int32_t source_sample_rate) {
#if !defined(SHERPA_ONNX_HAS_ORT_C_API)
  (void)model_path;
  (void)text_utf8;
  (void)vocab_json_utf8;
  (void)samples;
  (void)sample_count;
  (void)source_sample_rate;
  throw std::runtime_error(
      "Accurate alignment requires ONNX Runtime C API headers at build time (onnxruntime_c_api.h).");
#else
  auto vocab = ParseVocabJson(vocab_json_utf8);
  int32_t blankId = 0;
  auto blankIt = vocab.find("<pad>");
  if (blankIt != vocab.end()) {
    blankId = blankIt->second;
  }
  int32_t wordBoundaryId = 4;
  auto boundaryIt = vocab.find("|");
  if (boundaryIt != vocab.end()) {
    wordBoundaryId = boundaryIt->second;
  }

  std::vector<std::string> tokenTexts = BuildTokenTexts(text_utf8, vocab, wordBoundaryId);
  if (tokenTexts.empty()) {
    throw std::runtime_error("Transcript has no alignable tokens for provided vocabulary");
  }
  std::vector<int32_t> tokenIds;
  tokenIds.reserve(tokenTexts.size());
  for (const auto& token : tokenTexts) {
    auto it = vocab.find(token);
    if (it != vocab.end()) {
      tokenIds.push_back(it->second);
    } else {
      tokenIds.push_back(blankId);
    }
  }

  std::vector<float> raw(samples, samples + sample_count);
  std::vector<float> mono16k =
      source_sample_rate == 16000 ? raw : ResampleLinear(raw, source_sample_rate, 16000);
  std::vector<float> normalized = NormalizeAudio(mono16k);
  if (normalized.empty()) {
    throw std::runtime_error("Audio is empty after preprocessing");
  }

  std::vector<std::vector<float>> logProbs = RunOrtInference(model_path, normalized);
  if (logProbs.empty()) {
    throw std::runtime_error("Alignment model produced empty probabilities");
  }

  ExpandedTarget expanded = BuildExpandedTarget(tokenIds, blankId);
  std::vector<int32_t> path = CtcBacktrack(logProbs, expanded.ids, blankId);

  std::vector<std::vector<int32_t>> frameIndicesByToken(tokenIds.size());
  for (int32_t t = 0; t < static_cast<int32_t>(path.size()); ++t) {
    int32_t state = path[t];
    if (state < 0 || state >= static_cast<int32_t>(expanded.tokenIndices.size())) {
      continue;
    }
    int32_t tokenIndex = expanded.tokenIndices[state];
    int32_t tokenId = expanded.ids[state];
    if (tokenIndex >= 0 && tokenIndex < static_cast<int32_t>(frameIndicesByToken.size()) && tokenId != blankId) {
      frameIndicesByToken[tokenIndex].push_back(t);
    }
  }

  std::vector<AlignmentInterval> charItems;
  charItems.reserve(tokenTexts.size());
  int32_t fallbackEndFrame = 0;
  for (size_t i = 0; i < tokenTexts.size(); ++i) {
    if (tokenTexts[i] == "|") {
      continue;
    }
    const auto& frames = frameIndicesByToken[i];
    int32_t startFrame = fallbackEndFrame;
    int32_t endFrameExclusive = fallbackEndFrame;
    if (!frames.empty()) {
      startFrame = frames.front();
      endFrameExclusive = frames.back() + 1;
      fallbackEndFrame = std::max(fallbackEndFrame, endFrameExclusive);
    }
    double start = startFrame * 0.02;
    double end = std::max(start, endFrameExclusive * 0.02);
    charItems.push_back(AlignmentInterval{tokenTexts[i], start, end});
  }

  std::vector<AlignmentInterval> wordItems;
  std::string currentWord;
  double wordStart = 0.0;
  double wordEnd = 0.0;
  size_t charCursor = 0;
  for (const auto& token : tokenTexts) {
    if (token == "|") {
      if (!currentWord.empty()) {
        wordItems.push_back(AlignmentInterval{currentWord, wordStart, wordEnd});
        currentWord.clear();
      }
      continue;
    }
    if (charCursor >= charItems.size()) {
      continue;
    }
    const AlignmentInterval& charItem = charItems[charCursor++];
    if (currentWord.empty()) {
      wordStart = charItem.start_s;
      wordEnd = charItem.end_s;
    } else {
      wordEnd = std::max(wordEnd, charItem.end_s);
    }
    currentWord += charItem.text;
  }
  if (!currentWord.empty()) {
    wordItems.push_back(AlignmentInterval{currentWord, wordStart, wordEnd});
  }

  CtcAlignmentResult out;
  out.words = std::move(wordItems);
  out.chars = std::move(charItems);
  return out;
#endif
}

}  // namespace ctc_alignment
}  // namespace sherpa_onnx
