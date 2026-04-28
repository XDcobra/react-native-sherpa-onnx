#import "../../SherpaOnnx.h"
#import "../../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#import "../../segmentbuffer/core/SherpaOnnx+SegmentBufferGlobals.h"
#import "../../textbuffer/core/SherpaOnnx+TextBufferGlobals.h"

#include "../core/AlignmentBridgeUtils.h"
#include "../../../android/src/main/cpp/jni/model_detect/common/sherpa-onnx-model-detect.h"

#include <memory>
#include <mutex>
#include <new>
#include <cctype>
#include <numeric>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

static NSString *alignmentKindToNSString(sherpaonnx::AlignmentModelKind kind) {
  using K = sherpaonnx::AlignmentModelKind;
  switch (kind) {
    case K::kWav2Vec2:
      return @"wav2vec2";
    default:
      return @"unknown";
  }
}

static NSDictionary *alignmentDetectResultToDict(
    const sherpaonnx::AlignmentDetectResult &result) {
  NSMutableArray *detectedModelsArray = [NSMutableArray array];
  for (const auto &model : result.detectedModels) {
    [detectedModelsArray addObject:@{
      @"type": [NSString stringWithUTF8String:model.type.c_str()] ?: @"",
      @"modelDir": [NSString stringWithUTF8String:model.modelDir.c_str()] ?: @""
    }];
  }

  NSMutableDictionary *dict = [@{
    @"success": @(result.ok),
    @"detectedModels": detectedModelsArray,
    @"modelType": alignmentKindToNSString(result.selectedKind),
  } mutableCopy];
  if (!result.paths.model.empty()) {
    dict[@"paths"] = @{
      @"model": [NSString stringWithUTF8String:result.paths.model.c_str()] ?: @""
    };
  }
  if (!result.ok && !result.error.empty()) {
    dict[@"error"] = [NSString stringWithUTF8String:result.error.c_str()] ?: @"Alignment model detection failed";
  }

  if (!result.detectionSources.empty()) {
    NSMutableArray *sources = [NSMutableArray arrayWithCapacity:result.detectionSources.size()];
    for (auto s : result.detectionSources) {
      [sources addObject:[NSString stringWithUTF8String:sherpaonnx::DetectionSourceToLiteral(s)]];
    }
    dict[@"detectionSources"] = sources;
  }

  if (!result.derivedLanguages.empty()) {
    NSMutableArray *langs = [NSMutableArray arrayWithCapacity:result.derivedLanguages.size()];
    for (const auto &lang : result.derivedLanguages) {
      [langs addObject:[NSString stringWithUTF8String:lang.c_str()] ?: @""];
    }
    dict[@"languages"] = langs;
  }

  if (!result.quantization.empty()) {
    dict[@"quantization"] = [NSString stringWithUTF8String:result.quantization.c_str()] ?: @"";
  }

  return dict;
}

static NSString *const kAlignmentErrCode = @"ALIGNMENT_ERROR";
static NSString *const kAlignmentErrTextBufferNotFound = @"ALIGNMENT_TEXT_BUFFER_NOT_FOUND";
static NSString *const kAlignmentErrTextBufferKindMismatch = @"ALIGNMENT_TEXT_BUFFER_KIND_MISMATCH";
static NSString *const kAlignmentErrTextBufferEmpty = @"ALIGNMENT_TEXT_BUFFER_EMPTY";
static NSString *const kAlignmentErrAudioBufferNotFound = @"ALIGNMENT_AUDIO_BUFFER_NOT_FOUND";
static NSString *const kAlignmentErrAudioBufferKindMismatch = @"ALIGNMENT_AUDIO_BUFFER_KIND_MISMATCH";
static NSString *const kAlignmentErrAudioBufferEmpty = @"ALIGNMENT_AUDIO_BUFFER_EMPTY";
static NSString *const kAlignmentErrOfflineOom = @"OFFLINE_OOM";
static NSString *const kAlignmentOfflineOomMessage =
    @"Not enough memory for offline alignment. Please use smaller chunks or a streaming-friendly pipeline.";
static NSString *const kSegmentErrBufferNotFound = @"SEGMENT_BUFFER_NOT_FOUND";
static NSString *const kSegmentErrBufferKindMismatch = @"SEGMENT_BUFFER_KIND_MISMATCH";
static NSString *const kSegmentErrInvalidArgument = @"SEGMENT_INVALID_ARGUMENT";
static NSString *const kSegmentErrInvalidState = @"SEGMENT_INVALID_STATE";
static NSString *extractAlignmentCodeFromMessage(NSString *message) {
  if (message == nil) return kAlignmentErrCode;
  NSRange r = [message rangeOfString:@":"];
  if (r.location == NSNotFound || r.location == 0) return kAlignmentErrCode;
  NSString *prefix = [[message substringToIndex:r.location]
      stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if ([prefix hasPrefix:@"ALIGNMENT_"]) {
    return prefix;
  }
  return kAlignmentErrCode;
}

static std::string alignmentTimingModeToSegmentTimingMode(const std::string &timingMode, const std::string &fallbackMode) {
  if (timingMode == "aligned") return "accurate";
  if (timingMode == "proportional" || timingMode == "estimated" || timingMode == "accurate" || timingMode == "vad") {
    return timingMode;
  }
  return fallbackMode;
}

static std::vector<std::string> splitTextUnits(const std::string &text, const std::string &granularity) {
  std::vector<std::string> units;
  if (granularity == "word") {
    std::string current;
    for (char c : text) {
      if (std::isspace(static_cast<unsigned char>(c))) {
        if (!current.empty()) {
          units.push_back(current);
          current.clear();
        }
      } else {
        current.push_back(c);
      }
    }
    if (!current.empty()) units.push_back(current);
    return units;
  }

  std::string current;
  for (size_t i = 0; i < text.size(); ++i) {
    const char c = text[i];
    current.push_back(c);
    if (c == '.' || c == '!' || c == '?') {
      size_t j = i + 1;
      while (j < text.size() && std::isspace(static_cast<unsigned char>(text[j]))) j++;
      if (!current.empty()) {
        units.push_back(current);
        current.clear();
      }
      i = j - 1;
    }
  }
  if (!current.empty()) units.push_back(current);
  return units;
}

static double unitWeight(const std::string &unit) {
  size_t count = 0;
  for (char c : unit) {
    if (!std::isspace(static_cast<unsigned char>(c))) count++;
  }
  return static_cast<double>(std::max<size_t>(1, count));
}

static std::vector<std::vector<std::string>> mapUnitsToAnchorsMonotonicWeight(
    const std::vector<std::string> &units,
    const std::vector<SegRecord> &anchors) {
  std::vector<std::vector<std::string>> out(anchors.size());
  if (units.empty() || anchors.empty()) return out;

  std::vector<double> anchorCum(anchors.size(), 0.0);
  double totalAnchor = 0.0;
  for (const auto &a : anchors) {
    totalAnchor += std::max(1, a.endSample - a.startSample);
  }
  totalAnchor = std::max(1.0, totalAnchor);
  double accAnchor = 0.0;
  for (size_t i = 0; i < anchors.size(); ++i) {
    accAnchor += std::max(1, anchors[i].endSample - anchors[i].startSample);
    anchorCum[i] = accAnchor / totalAnchor;
  }

  std::vector<double> weights(units.size(), 1.0);
  double totalWeight = 0.0;
  for (size_t i = 0; i < units.size(); ++i) {
    weights[i] = unitWeight(units[i]);
    totalWeight += weights[i];
  }
  totalWeight = std::max(1.0, totalWeight);
  double accUnits = 0.0;
  for (size_t i = 0; i < units.size(); ++i) {
    const double mid = (accUnits + (weights[i] / 2.0)) / totalWeight;
    size_t anchorIdx = 0;
    while (anchorIdx + 1 < anchorCum.size() && anchorCum[anchorIdx] < mid) {
      anchorIdx++;
    }
    out[anchorIdx].push_back(units[i]);
    accUnits += weights[i];
  }
  return out;
}

}  // namespace

@implementation SherpaOnnx (Alignment)

- (void)detectAlignmentModel:(NSString *)modelDir
                  modelType:(NSString *)modelType
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
  @try {
    std::string modelDirStr = (modelDir != nil) ? [modelDir UTF8String] : "";
    std::string modelTypeStr =
        (modelType != nil && [modelType length] > 0) ? [modelType UTF8String]
                                                      : "auto";
    auto result = sherpaonnx::DetectAlignmentModel(modelDirStr, modelTypeStr);
    resolve(alignmentDetectResultToDict(result));
  } @catch (NSException *exception) {
    reject(@"DETECT_ERROR",
           [NSString stringWithFormat:@"Alignment detect failed: %@",
                                      exception.reason],
           nil);
  }
}

- (void)alignOfflineTextToAudio:(NSString *)textInBufferId
                 audioInBufferId:(NSString *)audioInBufferId
               segmentOutBufferId:(NSString *)segmentOutBufferId
                            mode:(NSString *)mode
                     granularity:(NSString *)granularity
                         options:(NSDictionary *)options
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
  if (textInBufferId == nil || [textInBufferId length] == 0) {
    reject(kAlignmentErrTextBufferNotFound, @"textInBufferId is required", nil);
    return;
  }
  if (audioInBufferId == nil || [audioInBufferId length] == 0) {
    reject(kAlignmentErrAudioBufferNotFound, @"audioInBufferId is required", nil);
    return;
  }
  if (segmentOutBufferId == nil || [segmentOutBufferId length] == 0) {
    reject(kSegmentErrInvalidArgument, @"segmentOutBufferId is required", nil);
    return;
  }

  dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
    try {
      std::string textId = [textInBufferId UTF8String];
      std::string audioId = [audioInBufferId UTF8String];
      std::string segmentOutId = [segmentOutBufferId UTF8String];

      if (textId.find("txt_off_") != 0) {
        reject(kAlignmentErrTextBufferKindMismatch,
               [NSString stringWithFormat:@"Expected offline text buffer (txt_off_*), got: %@", textInBufferId],
               nil);
        return;
      }

      {
        std::lock_guard<std::mutex> txtLock(g_txt_mutex);
        auto it = g_txt_offline.find(textId);
        if (it == g_txt_offline.end()) {
          if (g_txt_live.find(textId) != g_txt_live.end()) {
            reject(kAlignmentErrTextBufferKindMismatch,
                   [NSString stringWithFormat:@"Expected offline text buffer (txt_off_*), got live buffer: %@", textInBufferId],
                   nil);
          } else {
            reject(kAlignmentErrTextBufferNotFound,
                   [NSString stringWithFormat:@"Offline text buffer not found: %@", textInBufferId],
                   nil);
          }
          return;
        }
      }

      std::string inputText;
      std::string textReadErr;
      if (!txt_read_offline_text(textId, &inputText, &textReadErr) || inputText.empty()) {
        reject(kAlignmentErrTextBufferEmpty,
               [NSString stringWithFormat:@"Offline text buffer is empty or not populated: %@", textInBufferId],
               nil);
        return;
      }

      if (audioId.find("off_") != 0) {
        reject(kAlignmentErrAudioBufferKindMismatch,
               [NSString stringWithFormat:@"Expected offline audio buffer (off_*), got: %@", audioInBufferId],
               nil);
        return;
      }

      {
        std::lock_guard<std::mutex> paLock(g_pa_mutex);
        auto it = g_pa_offline.find(audioId);
        if (it == g_pa_offline.end()) {
          if (g_pa_live.find(audioId) != g_pa_live.end()) {
            reject(kAlignmentErrAudioBufferKindMismatch,
                   [NSString stringWithFormat:@"Expected offline audio buffer (off_*), got live buffer: %@", audioInBufferId],
                   nil);
          } else {
            reject(kAlignmentErrAudioBufferNotFound,
                   [NSString stringWithFormat:@"Offline audio buffer not found: %@", audioInBufferId],
                   nil);
          }
          return;
        }
      }
      if (segmentOutId.find("seg_off_") != 0) {
        reject(kSegmentErrBufferKindMismatch,
               [NSString stringWithFormat:@"Expected offline segment buffer (seg_off_*), got: %@", segmentOutBufferId],
               nil);
        return;
      }
      std::shared_ptr<SegOfflineEntry> outputEntry;
      {
        std::lock_guard<std::mutex> segLock(g_seg_mutex);
        auto segIt = g_seg_offline.find(segmentOutId);
        if (segIt == g_seg_offline.end()) {
          reject(kSegmentErrBufferNotFound,
                 [NSString stringWithFormat:@"Offline segment buffer not found: %@", segmentOutBufferId],
                 nil);
          return;
        }
        outputEntry = segIt->second;
      }

      int inputSampleRate = 0;
      int inputNumSamples = 0;
      std::string paMetaErrCode;
      std::string paMetaErrMsg;
      if (!pa_get_offline_metadata(audioId, &inputSampleRate, &inputNumSamples, &paMetaErrCode, &paMetaErrMsg)) {
        reject(kAlignmentErrAudioBufferNotFound,
               [NSString stringWithFormat:@"Offline audio buffer not found: %@", audioInBufferId],
               nil);
        return;
      }

      if (inputSampleRate <= 0 || inputNumSamples <= 0) {
        reject(kAlignmentErrAudioBufferEmpty,
               [NSString stringWithFormat:@"Offline audio buffer is empty: %@", audioInBufferId],
               nil);
        return;
      }

      std::string modeStr = sherpaonnx::alignment::bridge::NormalizeMode(mode);
      std::string granularityStr = sherpaonnx::alignment::bridge::NormalizeGranularity(granularity);
      if (modeStr == "vad" && granularityStr == "character") {
        reject(kSegmentErrInvalidArgument, @"mode=vad supports only sentence or word granularity", nil);
        return;
      }
      sherpa_onnx::alignment::AlignmentResult result;
      if (modeStr == "proportional") {
        result = sherpa_onnx::alignment::AlignProportional(
            inputText,
            inputNumSamples,
            inputSampleRate,
            granularityStr);
      } else if (modeStr == "estimated") {
        int32_t sr = sherpaonnx::alignment::bridge::ParseEstimatedSampleRate(options, inputSampleRate);
        auto counts = sherpaonnx::alignment::bridge::ParseSegmentSampleCounts(options);
        result = sherpa_onnx::alignment::AlignEstimated(
            inputText,
            counts,
            sr,
            granularityStr);
      } else if (modeStr == "accurate") {
        std::string modelPathStr = sherpaonnx::alignment::bridge::ParseAlignmentModelPath(options);
        const std::string segmentationSource = sherpaonnx::alignment::bridge::ParseSegmentationSource(options);
        if (segmentationSource == "vad") {
          if (granularityStr == "character") {
            reject(kSegmentErrInvalidArgument, @"accurate+vad supports only sentence or word granularity", nil);
            return;
          }
          const std::string segSourceId = sherpaonnx::alignment::bridge::ParseSegmentationBufferId(options);
          if (segSourceId.find("seg_off_") != 0) {
            reject(kSegmentErrBufferKindMismatch,
                   [NSString stringWithFormat:@"Expected offline segment buffer (seg_off_*), got: %s", segSourceId.c_str()],
                   nil);
            return;
          }
          const int minAnchors = sherpaonnx::alignment::bridge::ParseMinAnchors(options, 2);
          std::vector<SegRecord> anchors;
          {
            std::lock_guard<std::mutex> segLock(g_seg_mutex);
            auto it = g_seg_offline.find(segSourceId);
            if (it == g_seg_offline.end()) {
              reject(kSegmentErrBufferNotFound,
                     [NSString stringWithFormat:@"Offline segment buffer not found: %s", segSourceId.c_str()],
                     nil);
              return;
            }
            for (const auto &segment : it->second->segments) {
              if (segment.kind == "speech" && segment.endSample >= segment.startSample) {
                anchors.push_back(segment);
              }
            }
          }
          if ((int)anchors.size() < minAnchors) {
            std::lock_guard<std::mutex> segLock(g_seg_mutex);
            if (outputEntry->segments.size() > 0) {
              reject(kSegmentErrInvalidState,
                     [NSString stringWithFormat:@"Offline segment buffer already populated: %@", segmentOutBufferId],
                     nil);
              return;
            }
            outputEntry->segments.clear();
            NSString *warningCode = anchors.empty()
                ? @"ALIGNMENT_EMPTY_VAD_ANCHORS"
                : @"ALIGNMENT_BELOW_MIN_VAD_ANCHORS";
            resolve(@{
              @"outputSegmentBufferId": segmentOutBufferId,
              @"segmentsWritten": @(0),
              @"warningCode": warningCode,
              @"vadAnchorCount": @((int)anchors.size()),
              @"minAnchorsApplied": @(minAnchors),
            });
            return;
          }
          std::vector<float> pcm;
          int pcmSampleRate = 0;
          if (!pa_read_offline_samples(audioId, &pcm, &pcmSampleRate) || pcm.empty()) {
            reject(kAlignmentErrAudioBufferEmpty,
                   [NSString stringWithFormat:@"Offline audio buffer is empty: %@", audioInBufferId],
                   nil);
            return;
          }
          const auto units = splitTextUnits(inputText, granularityStr);
          const auto mapped = mapUnitsToAnchorsMonotonicWeight(units, anchors);
          const size_t unmappedCount = std::count_if(mapped.begin(), mapped.end(), [](const auto &group) {
            return group.empty();
          });
          std::vector<SegRecord> records;
          for (size_t i = 0; i < anchors.size(); ++i) {
            const auto &group = mapped[i];
            if (group.empty()) continue;
            std::string textJoined;
            for (size_t j = 0; j < group.size(); ++j) {
              if (j > 0) textJoined += " ";
              textJoined += group[j];
            }
            if (textJoined.empty()) continue;
            const auto &anchor = anchors[i];
            const int start = std::max(0, std::min(anchor.startSample, (int)pcm.size()));
            const int end = std::max(start, std::min(anchor.endSample, (int)pcm.size()));
            if (end <= start) continue;
            sherpa_onnx::alignment::AlignmentResult chunkResult;
            try {
              chunkResult = sherpa_onnx::alignment::AlignAccurateFromPcm(
                  modelPathStr,
                  textJoined,
                  pcm.data() + start,
                  end - start,
                  pcmSampleRate,
                  granularityStr);
            } catch (const std::exception &e) {
              throw std::runtime_error(
                  std::string("ALIGNMENT_CONSTRAINED_ACCURATE_ERROR: constrained accurate run failed for anchor ") +
                  std::to_string(i) + ": " + e.what());
            }
            const std::string timingMode = alignmentTimingModeToSegmentTimingMode(chunkResult.timing_mode, "accurate");
            for (size_t itemIndex = 0; itemIndex < chunkResult.subtitles.size(); ++itemIndex) {
              const auto &item = chunkResult.subtitles[itemIndex];
              const int localStart = std::max(0, static_cast<int>(std::round(item.start_s * pcmSampleRate)));
              const int localEnd = std::max(localStart, static_cast<int>(std::round(item.end_s * pcmSampleRate)));
              const int startSample = std::max(start, std::min(start + localStart, end));
              const int endSample = std::max(startSample, std::min(start + localEnd, end));
              SegRecord r;
              r.id = "seg_align_acc_vad_" + std::to_string(i) + "_" + std::to_string(itemIndex) + "_" +
                     std::to_string(startSample) + "_" + std::to_string(endSample);
              r.kind = "alignment";
              r.sourceAudioBufferId = audioId;
              r.startSample = startSample;
              r.endSample = endSample;
              r.sampleRate = inputSampleRate;
              r.durationMs = static_cast<int>(((std::max(0, endSample - startSample) * 1000.0) / std::max(1, inputSampleRate)));
              NSDictionary *tokenMetadata = @{
                @"constraintSource": @"vad",
                @"constraintMode": @"hard",
                @"mappingStrategy": @"vadMonotonicWeightDP",
                @"textUnitCount": @(units.size()),
                @"vadAnchorCount": @(anchors.size()),
                @"mappedUnitCount": @(group.size()),
                @"unmappedVadAnchorCount": @(unmappedCount),
                @"minAnchorsApplied": @(minAnchors),
              };
              NSDictionary *payload = @{
                @"text": [NSString stringWithUTF8String:item.text.c_str()] ?: @"",
                @"timingMode": [NSString stringWithUTF8String:timingMode.c_str()] ?: @"accurate",
                @"granularity": [NSString stringWithUTF8String:granularityStr.c_str()] ?: @"sentence",
                @"tokenMetadata": tokenMetadata,
              };
              NSData *payloadData = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
              if (payloadData != nil) {
                r.payloadJson.assign((const char *)payloadData.bytes, payloadData.length);
              }
              records.push_back(std::move(r));
            }
          }
          {
            std::lock_guard<std::mutex> segLock(g_seg_mutex);
            if (outputEntry->segments.size() > 0) {
              reject(kSegmentErrInvalidState,
                     [NSString stringWithFormat:@"Offline segment buffer already populated: %@", segmentOutBufferId],
                     nil);
              return;
            }
            outputEntry->segments = records;
          }
          resolve(@{
            @"outputSegmentBufferId": segmentOutBufferId,
            @"segmentsWritten": @((int)records.size()),
          });
          return;
        }
        std::vector<float> pcm;
        int pcmSampleRate = 0;
        if (!pa_read_offline_samples(audioId, &pcm, &pcmSampleRate) || pcm.empty()) {
          reject(kAlignmentErrAudioBufferEmpty,
                 [NSString stringWithFormat:@"Offline audio buffer is empty: %@", audioInBufferId],
                 nil);
          return;
        }
        result = sherpa_onnx::alignment::AlignAccurateFromPcm(
            modelPathStr,
            inputText,
            pcm.data(),
            pcm.size(),
            pcmSampleRate,
            granularityStr);
      } else if (modeStr == "vad") {
        const std::string segSourceId = sherpaonnx::alignment::bridge::ParseSegmentationBufferId(options);
        if (segSourceId.find("seg_off_") != 0) {
          reject(kSegmentErrBufferKindMismatch,
                 [NSString stringWithFormat:@"Expected offline segment buffer (seg_off_*), got: %s", segSourceId.c_str()],
                 nil);
          return;
        }
        std::vector<SegRecord> anchors;
        {
          std::lock_guard<std::mutex> segLock(g_seg_mutex);
          auto it = g_seg_offline.find(segSourceId);
          if (it == g_seg_offline.end()) {
            reject(kSegmentErrBufferNotFound,
                   [NSString stringWithFormat:@"Offline segment buffer not found: %s", segSourceId.c_str()],
                   nil);
            return;
          }
          for (const auto &segment : it->second->segments) {
            if (segment.kind == "speech" && segment.endSample >= segment.startSample) {
              anchors.push_back(segment);
            }
          }
        }
        if (anchors.empty()) {
          std::lock_guard<std::mutex> segLock(g_seg_mutex);
          if (outputEntry->segments.size() > 0) {
            reject(kSegmentErrInvalidState,
                   [NSString stringWithFormat:@"Offline segment buffer already populated: %@", segmentOutBufferId],
                   nil);
            return;
          }
          outputEntry->segments.clear();
          resolve(@{
            @"outputSegmentBufferId": segmentOutBufferId,
            @"segmentsWritten": @(0),
          });
          return;
        }

        const auto units = splitTextUnits(inputText, granularityStr);
        const auto mapped = mapUnitsToAnchorsMonotonicWeight(units, anchors);
        std::vector<SegRecord> records;
        records.reserve(anchors.size());
        const size_t unmappedCount = std::count_if(mapped.begin(), mapped.end(), [](const auto &group) {
          return group.empty();
        });
        for (size_t i = 0; i < anchors.size(); ++i) {
          const auto &group = mapped[i];
          if (group.empty()) continue;
          std::string textJoined;
          for (size_t j = 0; j < group.size(); ++j) {
            if (j > 0) textJoined += " ";
            textJoined += group[j];
          }
          if (textJoined.empty()) continue;
          const auto &anchor = anchors[i];
          SegRecord r;
          r.id = "seg_align_vad_" + std::to_string(i) + "_" + std::to_string(anchor.startSample) + "_" + std::to_string(anchor.endSample);
          r.kind = "alignment";
          r.sourceAudioBufferId = audioId;
          r.startSample = anchor.startSample;
          r.endSample = anchor.endSample;
          r.sampleRate = inputSampleRate;
          r.durationMs = static_cast<int>(((std::max(0, anchor.endSample - anchor.startSample) * 1000.0) / std::max(1, inputSampleRate)));
          NSDictionary *tokenMetadata = @{
            @"mappingStrategy": @"vadMonotonicWeightDP",
            @"textUnitCount": @(units.size()),
            @"vadAnchorCount": @(anchors.size()),
            @"mappedUnitCount": @(group.size()),
            @"unmappedVadAnchorCount": @(unmappedCount),
          };
          NSDictionary *payload = @{
            @"text": [NSString stringWithUTF8String:textJoined.c_str()] ?: @"",
            @"timingMode": @"vad",
            @"granularity": [NSString stringWithUTF8String:granularityStr.c_str()] ?: @"sentence",
            @"tokenMetadata": tokenMetadata,
          };
          NSData *payloadData = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
          if (payloadData != nil) {
            r.payloadJson.assign((const char *)payloadData.bytes, payloadData.length);
          }
          records.push_back(std::move(r));
        }
        {
          std::lock_guard<std::mutex> segLock(g_seg_mutex);
          if (outputEntry->segments.size() > 0) {
            reject(kSegmentErrInvalidState,
                   [NSString stringWithFormat:@"Offline segment buffer already populated: %@", segmentOutBufferId],
                   nil);
            return;
          }
          outputEntry->segments = records;
        }
        resolve(@{
          @"outputSegmentBufferId": segmentOutBufferId,
          @"segmentsWritten": @((int)records.size()),
        });
        return;
      } else {
        throw std::runtime_error("Unsupported alignment mode");
      }
      const std::string timingMode = alignmentTimingModeToSegmentTimingMode(result.timing_mode, modeStr);
      std::vector<SegRecord> records;
      records.reserve(result.subtitles.size());
      for (int i = 0; i < (int)result.subtitles.size(); ++i) {
        const auto &item = result.subtitles[i];
        const int startSample = std::max(0, static_cast<int>(std::round(item.start_s * inputSampleRate)));
        const int endSample = std::max(startSample, static_cast<int>(std::round(item.end_s * inputSampleRate)));
        SegRecord r;
        r.id = "seg_align_" + std::to_string(i) + "_" + std::to_string(startSample) + "_" + std::to_string(endSample);
        r.kind = "alignment";
        r.sourceAudioBufferId = audioId;
        r.startSample = startSample;
        r.endSample = endSample;
        r.sampleRate = inputSampleRate;
        r.durationMs = static_cast<int>(((std::max(0, endSample - startSample) * 1000.0) / std::max(1, inputSampleRate)));
        NSDictionary *payload = @{
          @"text": [NSString stringWithUTF8String:item.text.c_str()] ?: @"",
          @"timingMode": [NSString stringWithUTF8String:timingMode.c_str()] ?: @"",
          @"granularity": [NSString stringWithUTF8String:granularityStr.c_str()] ?: @"sentence",
        };
        NSData *payloadData = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
        if (payloadData != nil) {
          r.payloadJson.assign((const char *)payloadData.bytes, payloadData.length);
        }
        records.push_back(std::move(r));
      }
      {
        std::lock_guard<std::mutex> segLock(g_seg_mutex);
        if (outputEntry->segments.size() > 0) {
          reject(kSegmentErrInvalidState,
                 [NSString stringWithFormat:@"Offline segment buffer already populated: %@", segmentOutBufferId],
                 nil);
          return;
        }
        outputEntry->segments = records;
      }
      resolve(@{
        @"outputSegmentBufferId": segmentOutBufferId,
        @"segmentsWritten": @((int)records.size()),
      });
    } catch (const std::bad_alloc &) {
      reject(kAlignmentErrOfflineOom, kAlignmentOfflineOomMessage, nil);
    } catch (const std::exception &e) {
      NSString *errorMsg = [NSString stringWithUTF8String:e.what()] ?: @"Alignment failed";
      reject(extractAlignmentCodeFromMessage(errorMsg), errorMsg, nil);
    } catch (...) {
      reject(kAlignmentErrCode, @"Alignment failed", nil);
    }
  });
}

@end
