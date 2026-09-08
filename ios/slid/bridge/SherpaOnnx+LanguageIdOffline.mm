#import "../../SherpaOnnx.h"
#import <React/RCTLog.h>

#include "../../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "../core/LanguageIdBridgeState.h"

#include <chrono>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

namespace {

dispatch_queue_t LanguageIdSerialQueue() {
  static dispatch_queue_t queue;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    queue = dispatch_queue_create("com.sherpaonnx.languageid", DISPATCH_QUEUE_SERIAL);
  });
  return queue;
}

}  // namespace

@implementation SherpaOnnx (LanguageIdOffline)

- (void)initializeLanguageId:(NSString *)instanceId
                     options:(JS::NativeSherpaOnnx::LanguageIdInitBridgeOptions &)options
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"LANGUAGE_ID_INIT_ERROR", @"instanceId is required", nil);
    return;
  }

  NSString *encoder = options.encoder();
  NSString *decoder = options.decoder();
  if (encoder == nil || [encoder length] == 0 || decoder == nil || [decoder length] == 0) {
    reject(@"LANGUAGE_ID_INIT_ERROR", @"encoder and decoder paths are required", nil);
    return;
  }

  const std::string instanceIdStr = [instanceId UTF8String];
  const std::string encoderStr = [encoder UTF8String];
  const std::string decoderStr = [decoder UTF8String];

  const int32_t tailPaddings = options.tailPaddings().has_value()
      ? static_cast<int32_t>(options.tailPaddings().value())
      : -1;
  const int32_t numThreads = options.numThreads().has_value()
      ? std::max<int32_t>(1, static_cast<int32_t>(options.numThreads().value()))
      : 1;
  const bool debug = options.debug().has_value() ? options.debug().value() : false;
  std::string provider = "cpu";
  if (options.provider() != nil && [options.provider() length] > 0) {
    provider = [options.provider() UTF8String];
  }

  dispatch_async(LanguageIdSerialQueue(), ^{
    @try {
      SherpaOnnxSpokenLanguageIdentificationConfig config;
      std::memset(&config, 0, sizeof(config));
      config.whisper.encoder = encoderStr.c_str();
      config.whisper.decoder = decoderStr.c_str();
      config.whisper.tail_paddings = tailPaddings;
      config.num_threads = numThreads;
      config.debug = debug ? 1 : 0;
      config.provider = provider.c_str();

      const SherpaOnnxSpokenLanguageIdentification *handle =
          SherpaOnnxCreateSpokenLanguageIdentification(&config);

      if (handle == nullptr) {
        reject(@"LANGUAGE_ID_INIT_ERROR",
               @"Failed to create native SherpaOnnxSpokenLanguageIdentification instance",
               nil);
        return;
      }

      auto state = std::make_shared<sherpaonnx::language_id::bridge::LanguageIdInstanceState>();
      state->handle = handle;
      state->numThreads = numThreads;
      state->provider = provider;

      {
        std::lock_guard<std::mutex> lock(
            sherpaonnx::language_id::bridge::g_language_id_mutex);
        sherpaonnx::language_id::bridge::g_language_id_instances[instanceIdStr] = state;
      }

      resolve(@{ @"success": @YES });
    } @catch (NSException *exception) {
      reject(@"LANGUAGE_ID_INIT_ERROR",
             [NSString stringWithFormat:@"Language ID init failed: %@", exception.reason],
             nil);
    }
  });
}

- (void)identifyLanguageOffline:(NSString *)instanceId
                  audioBufferId:(NSString *)audioBufferId
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"LANGUAGE_ID_IDENTIFY_FAILED", @"instanceId is required", nil);
    return;
  }
  if (audioBufferId == nil || [audioBufferId length] == 0) {
    reject(@"LANGUAGE_ID_AUDIO_BUFFER_NOT_FOUND", @"audioBufferId is required", nil);
    return;
  }

  const std::string instanceIdStr = [instanceId UTF8String];
  const std::string audioInId = [audioBufferId UTF8String];

  auto state = sherpaonnx::language_id::bridge::LookupLanguageId(instanceIdStr);
  if (!state || state->handle == nullptr) {
    reject(@"LANGUAGE_ID_NOT_INITIALIZED",
           [NSString stringWithFormat:@"SLID instance not found: %@", instanceId],
           nil);
    return;
  }

  dispatch_async(LanguageIdSerialQueue(), ^{
    @try {
      std::vector<float> samples;
      int sampleRate = 0;
      if (!pa_read_offline_samples(audioInId, &samples, &sampleRate)) {
        reject(@"LANGUAGE_ID_AUDIO_BUFFER_NOT_FOUND",
               [NSString stringWithFormat:@"Offline audio buffer not found or unreadable: %@", audioBufferId],
               nil);
        return;
      }

      if (samples.empty()) {
        reject(@"LANGUAGE_ID_AUDIO_BUFFER_EMPTY",
               [NSString stringWithFormat:@"Offline audio buffer is empty: %@", audioBufferId],
               nil);
        return;
      }

      const auto t0 = std::chrono::steady_clock::now();
      const double audioDuration = (sampleRate > 0)
          ? static_cast<double>(samples.size()) / static_cast<double>(sampleRate)
          : 0.0;

      SherpaOnnxOfflineStream *stream =
          SherpaOnnxSpokenLanguageIdentificationCreateOfflineStream(state->handle);
      if (stream == nullptr) {
        reject(@"LANGUAGE_ID_IDENTIFY_FAILED", @"Failed to create offline stream", nil);
        return;
      }

      SherpaOnnxAcceptWaveformOffline(
          stream,
          sampleRate,
          samples.data(),
          static_cast<int32_t>(samples.size()));

      const SherpaOnnxSpokenLanguageIdentificationResult *result =
          SherpaOnnxSpokenLanguageIdentificationCompute(state->handle, stream);

      SherpaOnnxDestroyOfflineStream(stream);

      if (result == nullptr || result->lang == nullptr) {
        if (result != nullptr) {
          SherpaOnnxDestroySpokenLanguageIdentificationResult(result);
        }
        reject(@"LANGUAGE_ID_IDENTIFY_FAILED", @"Language identification compute returned null", nil);
        return;
      }

      NSString *langStr = [NSString stringWithUTF8String:result->lang];
      SherpaOnnxDestroySpokenLanguageIdentificationResult(result);

      const auto t1 = std::chrono::steady_clock::now();
      const double elapsedMs =
          std::chrono::duration<double, std::milli>(t1 - t0).count();

      resolve(@{
        @"lang": langStr ?: @"",
        @"audioDuration": @(audioDuration),
        @"elapsedMs": @(elapsedMs),
      });
    } @catch (NSException *exception) {
      reject(@"LANGUAGE_ID_IDENTIFY_FAILED",
             [NSString stringWithFormat:@"Language identification failed: %@", exception.reason],
             nil);
    }
  });
}

- (void)unloadLanguageId:(NSString *)instanceId
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    resolve(nil);
    return;
  }
  const std::string instanceIdStr = [instanceId UTF8String];
  dispatch_async(LanguageIdSerialQueue(), ^{
    sherpaonnx::language_id::bridge::RemoveLanguageId(instanceIdStr);
    resolve(nil);
  });
}

@end
