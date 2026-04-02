#import "SherpaOnnx.h"
#import <React/RCTLog.h>

#include "sherpa-onnx/c-api/cxx-api.h"

#if __has_include("../third_party/onnxruntime/include/onnxruntime/core/session/onnxruntime_c_api.h")
#include "../third_party/onnxruntime/include/onnxruntime/core/session/onnxruntime_c_api.h"
#define SHERPA_ONNX_HAS_ORT_C_API 1
#elif __has_include("onnxruntime_c_api.h")
#include "onnxruntime_c_api.h"
#define SHERPA_ONNX_HAS_ORT_C_API 1
#else
#define SHERPA_ONNX_HAS_ORT_C_API 0
#endif

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace {

struct AlignmentItem {
  std::string text;
  double start = 0.0;
  double end = 0.0;
};

struct ExpandedTarget {
  std::vector<int32_t> ids;
  std::vector<int32_t> tokenIndices;
};

static std::unordered_map<std::string, int32_t> ParseVocabJson(NSString *vocabJson) {
  if (vocabJson == nil || vocabJson.length == 0) {
    throw std::runtime_error("Vocabulary JSON is empty");
  }

  NSError *error = nil;
  NSData *data = [vocabJson dataUsingEncoding:NSUTF8StringEncoding];
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
  if (error != nil || ![parsed isKindOfClass:[NSDictionary class]]) {
    throw std::runtime_error("Failed to parse vocabulary JSON");
  }

  NSDictionary *dict = (NSDictionary *)parsed;
  std::unordered_map<std::string, int32_t> vocab;
  for (id key in dict) {
    if (![key isKindOfClass:[NSString class]]) {
      continue;
    }
    id value = dict[key];
    if (![value isKindOfClass:[NSNumber class]]) {
      continue;
    }

    NSString *token = (NSString *)key;
    vocab[std::string([token UTF8String])] = (int32_t)[(NSNumber *)value intValue];
  }

  if (vocab.empty()) {
    throw std::runtime_error("Vocabulary JSON has no valid entries");
  }

  return vocab;
}

static std::vector<std::string> BuildTokenTexts(
    const std::string &text,
    const std::unordered_map<std::string, int32_t> &vocab,
    int32_t wordBoundaryId) {
  NSString *source = [NSString stringWithUTF8String:text.c_str()];
  if (source == nil || source.length == 0) {
    return {};
  }

  NSString *uppercase = [source uppercaseStringWithLocale:[NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"]];
  std::vector<std::string> tokens;

  NSCharacterSet *ws = [NSCharacterSet whitespaceAndNewlineCharacterSet];
  for (NSUInteger i = 0; i < uppercase.length; ++i) {
    unichar c = [uppercase characterAtIndex:i];

    if ([ws characterIsMember:c]) {
      if (!tokens.empty() && tokens.back() != "|") {
        tokens.push_back("|");
      }
      continue;
    }

    unichar normalized = c;
    if (c == 0x2019 || c == 0x0060 || c == 0x00B4) {
      normalized = '\'';
    }

    NSString *token = [NSString stringWithCharacters:&normalized length:1];
    std::string tokenUtf8([token UTF8String]);
    if (vocab.find(tokenUtf8) != vocab.end()) {
      tokens.push_back(tokenUtf8);
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
    const std::vector<float> &input,
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
    double frac = srcPos - left;

    float leftVal = input[std::min(left, input.size() - 1)];
    float rightVal = input[right];
    output[i] = static_cast<float>(leftVal + (rightVal - leftVal) * frac);
  }

  return output;
}

static std::vector<float> NormalizeAudio(const std::vector<float> &input) {
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

  const double std = std::sqrt(std::max(variance, 1e-12));
  std::vector<float> out(input.size(), 0.0f);
  for (size_t i = 0; i < input.size(); ++i) {
    out[i] = static_cast<float>((input[i] - mean) / std);
  }

  return out;
}

static std::vector<std::vector<float>> LogSoftmax(
    const std::vector<float> &logitsFlat,
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

#if SHERPA_ONNX_HAS_ORT_C_API

static void CheckOrtStatus(const OrtApi *api, OrtStatus *status, const char *prefix) {
  if (status == nullptr) {
    return;
  }

  std::string message(prefix);
  message += ": ";
  message += api->GetErrorMessage(status);
  api->ReleaseStatus(status);
  throw std::runtime_error(message);
}

static std::vector<std::vector<float>> RunOrtInference(
    const std::string &modelPath,
    const std::vector<float> &samples) {
  const OrtApi *api = OrtGetApiBase()->GetApi(ORT_API_VERSION);

  OrtEnv *env = nullptr;
  OrtSessionOptions *sessionOptions = nullptr;
  OrtSession *session = nullptr;
  OrtAllocator *allocator = nullptr;
  OrtMemoryInfo *memoryInfo = nullptr;
  OrtValue *inputTensor = nullptr;
  OrtValue *outputTensor = nullptr;
  OrtTensorTypeAndShapeInfo *shapeInfo = nullptr;
  char *inputName = nullptr;
  char *outputName = nullptr;

  auto cleanup = [&]() {
    if (shapeInfo != nullptr) api->ReleaseTensorTypeAndShapeInfo(shapeInfo);
    if (outputTensor != nullptr) api->ReleaseValue(outputTensor);
    if (inputTensor != nullptr) api->ReleaseValue(inputTensor);
    if (memoryInfo != nullptr) api->ReleaseMemoryInfo(memoryInfo);
    if (inputName != nullptr && allocator != nullptr) api->AllocatorFree(allocator, inputName);
    if (outputName != nullptr && allocator != nullptr) api->AllocatorFree(allocator, outputName);
    if (session != nullptr) api->ReleaseSession(session);
    if (sessionOptions != nullptr) api->ReleaseSessionOptions(sessionOptions);
    if (env != nullptr) api->ReleaseEnv(env);
  };

  try {
    CheckOrtStatus(api, api->CreateEnv(ORT_LOGGING_LEVEL_WARNING, "sherpa-onnx-rn", &env), "CreateEnv failed");
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

    CheckOrtStatus(api, api->CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, &memoryInfo), "CreateCpuMemoryInfo failed");

    int64_t inputShape[2] = {1, static_cast<int64_t>(samples.size())};
    CheckOrtStatus(
        api,
        api->CreateTensorWithDataAsOrtValue(
            memoryInfo,
            const_cast<float *>(samples.data()),
            samples.size() * sizeof(float),
            inputShape,
            2,
            ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT,
            &inputTensor),
        "CreateTensorWithDataAsOrtValue failed");

    const char *inputNames[] = {inputName};
    const char *outputNames[] = {outputName};
    const OrtValue *inputValues[] = {inputTensor};

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

    int64_t elementCount = 0;
    CheckOrtStatus(api, api->GetTensorShapeElementCount(shapeInfo, &elementCount), "GetTensorShapeElementCount failed");
    if (elementCount <= 0) {
      throw std::runtime_error("Model output tensor is empty");
    }

    float *logitsData = nullptr;
    CheckOrtStatus(api, api->GetTensorMutableData(outputTensor, reinterpret_cast<void **>(&logitsData)), "GetTensorMutableData failed");

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

#endif

static std::vector<std::vector<float>> BuildFallbackLogProbs(
    int32_t frames,
    int32_t vocabSize,
    const std::vector<int32_t> &tokenIds,
    int32_t blankId) {
  std::vector<std::vector<float>> out(frames, std::vector<float>(vocabSize, -8.0f));
  if (frames <= 0 || vocabSize <= 0) {
    return out;
  }

  for (int32_t t = 0; t < frames; ++t) {
    out[t][std::clamp(blankId, 0, vocabSize - 1)] = -1.5f;
  }

  if (tokenIds.empty()) {
    return out;
  }

  for (size_t i = 0; i < tokenIds.size(); ++i) {
    int32_t frame = static_cast<int32_t>((static_cast<double>(i + 1) / (tokenIds.size() + 1)) * (frames - 1));
    frame = std::clamp(frame, 0, frames - 1);
    int32_t tokenId = std::clamp(tokenIds[i], 0, vocabSize - 1);
    out[frame][tokenId] = -0.1f;
  }

  return out;
}

static ExpandedTarget BuildExpandedTarget(const std::vector<int32_t> &tokenIds, int32_t blankId) {
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

static float SafeLogProb(const std::vector<float> &row, int32_t tokenId) {
  if (tokenId < 0 || tokenId >= static_cast<int32_t>(row.size())) {
    return -1.0e30f;
  }
  return row[tokenId];
}

static std::vector<int32_t> CtcBacktrack(
    const std::vector<std::vector<float>> &logProbs,
    const std::vector<int32_t> &expandedTarget,
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

  int32_t state =
      (S > 1 && trellis[T - 1][S - 2] > trellis[T - 1][S - 1]) ? (S - 2) : (S - 1);

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

static NSArray *AlignmentItemsToNSArray(const std::vector<AlignmentItem> &items) {
  NSMutableArray *array = [NSMutableArray arrayWithCapacity:items.size()];
  for (const auto &item : items) {
    [array addObject:@{
      @"text": [NSString stringWithUTF8String:item.text.c_str()] ?: @"",
      @"start": @(item.start),
      @"end": @(item.end),
    }];
  }
  return array;
}

}  // namespace

@implementation SherpaOnnx (Alignment)

- (void)runCTCForcedAlignment:(NSString *)modelPath
                    audioPath:(NSString *)audioPath
                         text:(NSString *)text
                    vocabJson:(NSString *)vocabJson
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
  if (modelPath == nil || [modelPath length] == 0) {
    reject(@"ALIGNMENT_ERROR", @"modelPath is required", nil);
    return;
  }
  if (audioPath == nil || [audioPath length] == 0) {
    reject(@"ALIGNMENT_ERROR", @"audioPath is required", nil);
    return;
  }
  if (text == nil || [text length] == 0) {
    reject(@"ALIGNMENT_ERROR", @"text is required", nil);
    return;
  }

  dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
    try {
      std::string modelPathStr([modelPath UTF8String]);
      std::string audioPathStr([audioPath UTF8String]);
      std::string textStr([text UTF8String]);

      auto vocab = ParseVocabJson(vocabJson);
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

      std::vector<std::string> tokenTexts = BuildTokenTexts(textStr, vocab, wordBoundaryId);
      if (tokenTexts.empty()) {
        reject(@"ALIGNMENT_ERROR", @"Transcript has no alignable tokens for provided vocabulary", nil);
        return;
      }

      std::vector<int32_t> tokenIds;
      tokenIds.reserve(tokenTexts.size());
      for (const auto &token : tokenTexts) {
        auto it = vocab.find(token);
        if (it != vocab.end()) {
          tokenIds.push_back(it->second);
        } else {
          tokenIds.push_back(blankId);
        }
      }

      sherpa_onnx::cxx::Wave wave = sherpa_onnx::cxx::ReadWave(audioPathStr);
      if (wave.samples.empty() || wave.sample_rate <= 0) {
        reject(@"ALIGNMENT_ERROR", @"Failed to read WAV audio for alignment", nil);
        return;
      }

      std::vector<float> mono16k =
          wave.sample_rate == 16000 ? wave.samples : ResampleLinear(wave.samples, wave.sample_rate, 16000);
      std::vector<float> normalized = NormalizeAudio(mono16k);
      if (normalized.empty()) {
        reject(@"ALIGNMENT_ERROR", @"Audio is empty after preprocessing", nil);
        return;
      }

      std::vector<std::vector<float>> logProbs;
#if SHERPA_ONNX_HAS_ORT_C_API
      logProbs = RunOrtInference(modelPathStr, normalized);
#else
      {
        int32_t approxFrames = std::max<int32_t>(1, static_cast<int32_t>(normalized.size() / 320));
        int32_t vocabSize = 32;
        logProbs = BuildFallbackLogProbs(approxFrames, vocabSize, tokenIds, blankId);
      }
#endif

      if (logProbs.empty()) {
        reject(@"ALIGNMENT_ERROR", @"Alignment model produced empty probabilities", nil);
        return;
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

      std::vector<AlignmentItem> charItems;
      charItems.reserve(tokenTexts.size());

      int32_t fallbackEndFrame = 0;
      for (size_t i = 0; i < tokenTexts.size(); ++i) {
        if (tokenTexts[i] == "|") {
          continue;
        }

        const auto &frames = frameIndicesByToken[i];
        int32_t startFrame = fallbackEndFrame;
        int32_t endFrameExclusive = fallbackEndFrame;
        if (!frames.empty()) {
          startFrame = frames.front();
          endFrameExclusive = frames.back() + 1;
          fallbackEndFrame = std::max(fallbackEndFrame, endFrameExclusive);
        }

        double start = startFrame * 0.02;
        double end = std::max(start, endFrameExclusive * 0.02);
        charItems.push_back(AlignmentItem{tokenTexts[i], start, end});
      }

      std::vector<AlignmentItem> wordItems;
      std::string currentWord;
      double wordStart = 0.0;
      double wordEnd = 0.0;
      size_t charCursor = 0;

      for (const auto &token : tokenTexts) {
        if (token == "|") {
          if (!currentWord.empty()) {
            wordItems.push_back(AlignmentItem{currentWord, wordStart, wordEnd});
            currentWord.clear();
          }
          continue;
        }

        if (charCursor >= charItems.size()) {
          continue;
        }

        const AlignmentItem &charItem = charItems[charCursor++];
        if (currentWord.empty()) {
          wordStart = charItem.start;
          wordEnd = charItem.end;
        } else {
          wordEnd = std::max(wordEnd, charItem.end);
        }
        currentWord += charItem.text;
      }

      if (!currentWord.empty()) {
        wordItems.push_back(AlignmentItem{currentWord, wordStart, wordEnd});
      }

      resolve(@{
        @"words": AlignmentItemsToNSArray(wordItems),
        @"chars": AlignmentItemsToNSArray(charItems),
      });
    } catch (const std::exception &e) {
      NSString *errorMsg = [NSString stringWithUTF8String:e.what()] ?: @"CTC alignment failed";
      reject(@"ALIGNMENT_ERROR", errorMsg, nil);
    } catch (...) {
      reject(@"ALIGNMENT_ERROR", @"CTC alignment failed", nil);
    }
  });
}

@end
