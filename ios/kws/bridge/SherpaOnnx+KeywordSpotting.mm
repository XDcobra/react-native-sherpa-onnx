#import "../../SherpaOnnx.h"
#import <React/RCTLog.h>

#include "../native/sherpa-onnx-kws-wrapper.h"

#include <algorithm>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

namespace {

std::unordered_map<std::string, std::unique_ptr<sherpaonnx::KwsWrapper>>
    g_kws_instances;
std::mutex g_kws_mutex;

bool ReadRequiredPath(
    NSString *value,
    const char *name,
    std::string &output,
    RCTPromiseRejectBlock reject) {
  if (value == nil || [value length] == 0) {
    reject(@"KWS_INIT_FAILED",
           [NSString stringWithFormat:@"%s path is required", name], nil);
    return false;
  }
  output = [value UTF8String];
  return true;
}

}  // namespace

@implementation SherpaOnnx (KeywordSpotting)

- (void)initializeKeywordSpotting:(NSString *)instanceId
                          options:(JS::NativeSherpaOnnx::KeywordSpottingInitBridgeOptions &)options
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    reject(@"KWS_INIT_FAILED", @"instanceId is required", nil);
    return;
  }

  std::string encoder;
  std::string decoder;
  std::string joiner;
  std::string tokens;
  std::string keywords;
  if (!ReadRequiredPath(options.encoder(), "encoder", encoder, reject) ||
      !ReadRequiredPath(options.decoder(), "decoder", decoder, reject) ||
      !ReadRequiredPath(options.joiner(), "joiner", joiner, reject) ||
      !ReadRequiredPath(options.tokens(), "tokens", tokens, reject) ||
      !ReadRequiredPath(options.keywords(), "keywords", keywords, reject)) {
    return;
  }

  const std::string key = [instanceId UTF8String];
  const auto keywordsScore = options.keywordsScore();
  const auto keywordsThreshold = options.keywordsThreshold();
  const auto numTrailingBlanks = options.numTrailingBlanks();
  const auto maxActivePaths = options.maxActivePaths();
  const auto numThreads = options.numThreads();
  const auto debug = options.debug();
  NSString *providerValue = options.provider();
  const std::string provider =
      providerValue != nil && [providerValue length] > 0
          ? std::string([providerValue UTF8String])
          : "cpu";

  try {
    std::lock_guard<std::mutex> lock(g_kws_mutex);
    if (g_kws_instances.find(key) != g_kws_instances.end()) {
      reject(@"KWS_INIT_FAILED",
             [NSString stringWithFormat:
                 @"Keyword spotting instance already exists: %@", instanceId],
             nil);
      return;
    }

    auto wrapper = std::make_unique<sherpaonnx::KwsWrapper>();
    const auto result = wrapper->initialize(
        encoder,
        decoder,
        joiner,
        tokens,
        keywords,
        keywordsScore.has_value() ? (float)keywordsScore.value() : 1.5f,
        keywordsThreshold.has_value() ? (float)keywordsThreshold.value() : 0.25f,
        numTrailingBlanks.has_value()
            ? (int32_t)numTrailingBlanks.value() : 2,
        maxActivePaths.has_value() ? (int32_t)maxActivePaths.value() : 4,
        numThreads.has_value()
            ? std::max<int32_t>(1, (int32_t)numThreads.value()) : 1,
        provider,
        debug.has_value() && debug.value());
    if (!result.success) {
      reject(@"KWS_INIT_FAILED",
             [NSString stringWithUTF8String:result.error.c_str()], nil);
      return;
    }

    g_kws_instances.emplace(key, std::move(wrapper));
    RCTLogInfo(@"[SherpaOnnx:kws] initialized instanceId=%@", instanceId);
    resolve(@{@"success" : @YES});
  } catch (const std::exception &e) {
    reject(@"KWS_INIT_FAILED", [NSString stringWithUTF8String:e.what()], nil);
  } catch (...) {
    reject(@"KWS_INIT_FAILED", @"Unknown keyword spotting init error", nil);
  }
}

- (void)unloadKeywordSpotting:(NSString *)instanceId
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
  if (instanceId == nil || [instanceId length] == 0) {
    resolve(nil);
    return;
  }

  try {
    const std::string key = [instanceId UTF8String];
    std::lock_guard<std::mutex> lock(g_kws_mutex);
    auto it = g_kws_instances.find(key);
    if (it != g_kws_instances.end()) {
      it->second->unload();
      g_kws_instances.erase(it);
    }
    RCTLogInfo(@"[SherpaOnnx:kws] unloaded instanceId=%@", instanceId);
    resolve(nil);
  } catch (const std::exception &e) {
    reject(@"KWS_INTERNAL_ERROR", [NSString stringWithUTF8String:e.what()], nil);
  } catch (...) {
    reject(@"KWS_INTERNAL_ERROR", @"Unknown keyword spotting unload error", nil);
  }
}

@end
