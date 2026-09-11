#include "AudioTaggingOfflineLivePipelineWorker.h"

#import <Foundation/Foundation.h>

#include "../../segmentbuffer/core/SherpaOnnx+SegmentBufferGlobals.h"
#include "../../textbuffer/core/SherpaOnnx+TextBufferGlobals.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

constexpr int kMinDurationMs = 1500;

std::string EscapeJsonString(const std::string &value) {
  std::string escaped;
  escaped.reserve(value.size());
  for (char c : value) {
    if (c == '\\' || c == '"') {
      escaped.push_back('\\');
    }
    escaped.push_back(c);
  }
  return escaped;
}

std::string BuildAudioTaggingPayloadJson(
  const std::string &primaryName,
  const NSArray *events
) {
  NSMutableArray *eventMaps = [NSMutableArray array];
  if (events != nil) {
    for (id item in events) {
      if (![item isKindOfClass:[NSDictionary class]]) continue;
      NSDictionary *ev = (NSDictionary *)item;
      NSString *name = [ev[@"name"] isKindOfClass:[NSString class]] ? ev[@"name"] : @"";
      NSNumber *index = [ev[@"index"] isKindOfClass:[NSNumber class]] ? ev[@"index"] : @(-1);
      NSNumber *prob = [ev[@"prob"] isKindOfClass:[NSNumber class]] ? ev[@"prob"] : @(0.0);
      [eventMaps addObject:@{
        @"name": name ?: @"",
        @"index": index,
        @"prob": prob,
      }];
    }
  }

  NSError *error = nil;
  NSData *jsonData = [NSJSONSerialization dataWithJSONObject:@{
    @"source": @"audioTagging",
    @"primaryName": [NSString stringWithUTF8String:primaryName.c_str()] ?: @"",
    @"events": eventMaps,
  } options:0 error:&error];
  if (jsonData == nil) {
    return std::string("{\"source\":\"audioTagging\",\"primaryName\":\"") +
           EscapeJsonString(primaryName) + "\",\"events\":[]}";
  }
  NSString *json = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
  return json != nil ? std::string([json UTF8String]) : "{}";
}

}  // namespace

AudioTaggingOfflineLivePipelineWorker::AudioTaggingOfflineLivePipelineWorker(
  std::string pipelineId,
  std::string attachedSegmentationEngineId,
  std::shared_ptr<PaLiveEntry> audioInput,
  std::string audioSegmentInputBufferId,
  std::string audioInBufferId,
  std::shared_ptr<TxtLiveEntry> textOutput,
  std::string targetSegmentsOutBufferId,
  std::shared_ptr<sherpaonnx::audio_tagging::bridge::AudioTaggingInstanceState> taggingState,
  int32_t topK
)
  : OfflineLivePipelineWorker(
      std::move(pipelineId),
      std::move(attachedSegmentationEngineId),
      audioInput,
      std::move(audioSegmentInputBufferId),
      nullptr
    ),
    audioInput_(std::move(audioInput)),
    audioInBufferId_(std::move(audioInBufferId)),
    textOutput_(std::move(textOutput)),
    targetSegmentsOutBufferId_(std::move(targetSegmentsOutBufferId)),
    taggingState_(std::move(taggingState)),
    topK_(std::max<int32_t>(1, topK))
{}

void AudioTaggingOfflineLivePipelineWorker::onSegmentCommitted(
  const CommittedSegmentRef &segment
) {
  if (!std::holds_alternative<CommittedSegmentSpeech>(segment)) return;
  if (!audioInput_ || !textOutput_ || !taggingState_ || taggingState_->handle == nullptr) {
    throw std::runtime_error("Invalid audio tagging live pipeline worker state");
  }

  const auto &speech = std::get<CommittedSegmentSpeech>(segment);
  const int frameCount = std::max(0, speech.endSample - speech.startSample);
  if (frameCount <= 0) return;

  const int durationMs = speech.durationMs > 0
      ? speech.durationMs
      : ((speech.sampleRate > 0) ? (frameCount * 1000) / speech.sampleRate : 0);
  if (durationMs < kMinDurationMs) {
    return;
  }

  auto samples = audioInput_->getSamplesSlice(speech.startSample, frameCount);
  if (samples.empty()) return;

  NSMutableArray *events = [NSMutableArray array];
  std::string primaryName;

  const SherpaOnnxOfflineStream *stream =
      SherpaOnnxAudioTaggingCreateOfflineStream(taggingState_->handle);
  if (stream != nullptr) {
    SherpaOnnxAcceptWaveformOffline(
        stream,
        speech.sampleRate,
        samples.data(),
        static_cast<int32_t>(samples.size()));
    const SherpaOnnxAudioEvent *const *results =
        SherpaOnnxAudioTaggingCompute(taggingState_->handle, stream, topK_);
    if (results != nullptr) {
      for (int32_t i = 0; results[i] != nullptr; ++i) {
        const SherpaOnnxAudioEvent *ev = results[i];
        NSString *name = ev->name != nullptr
            ? [NSString stringWithUTF8String:ev->name]
            : @"";
        [events addObject:@{
          @"name": name ?: @"",
          @"index": @(ev->index),
          @"prob": @(ev->prob),
        }];
        if (primaryName.empty() && name != nil && [name length] > 0) {
          primaryName = [name UTF8String];
        }
      }
      SherpaOnnxAudioTaggingFreeResults(results);
    }
    SherpaOnnxDestroyOfflineStream(stream);
  }

  if (primaryName.empty() || events.count == 0) return;

  const float startTime =
      speech.sampleRate > 0
          ? static_cast<float>(speech.startSample) / static_cast<float>(speech.sampleRate)
          : 0.f;
  const float endTime =
      speech.sampleRate > 0
          ? static_cast<float>(speech.endSample) / static_cast<float>(speech.sampleRate)
          : 0.f;

  // LiveText meta is a Fabric-safe JSON tree (nested events array).
  NSDictionary *meta = @{
    @"durationMs": @(durationMs),
    @"events": events,
  };

  std::vector<std::string> tokens;
  std::vector<float> timestamps = { startTime, endTime };
  std::string err;
  if (!txt_live_commit_segment(
        textOutput_,
        primaryName,
        tokens,
        timestamps,
        "audio_tagging",
        meta,
        &err
      )) {
    throw std::runtime_error(
      err.empty() ? "Failed to commit audio tagging text segment" : err
    );
  }
  addUnitsWritten(static_cast<int64_t>(primaryName.size()));

  if (targetSegmentsOutBufferId_.empty()) return;

  const std::string payloadJson = BuildAudioTaggingPayloadJson(primaryName, events);
  const std::string sourceAudioBufferId =
      speech.sourceAudioBufferId.empty() ? audioInBufferId_ : speech.sourceAudioBufferId;

  std::string segmentId;
  int segmentIndex = -1;
  std::string appendError;
  const bool ok = seg_live_append_segment(
    targetSegmentsOutBufferId_,
    "speech",
    sourceAudioBufferId,
    speech.startSample,
    speech.endSample,
    speech.sampleRate,
    durationMs,
    speech.hasConfidence,
    speech.confidence,
    payloadJson,
    &segmentId,
    &segmentIndex,
    &appendError
  );
  if (!ok) {
    throw std::runtime_error(
      appendError.empty() ? "Failed to append audio tagging labeled segment" : appendError
    );
  }
}
