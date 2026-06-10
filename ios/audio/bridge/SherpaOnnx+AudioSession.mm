/**
 * SherpaOnnx+AudioSession.mm — Bridge methods for the pipeline audio session coordinator.
 *
 * Exposes configurePipelineAudioSession, setPipelineAudioRoutePreference,
 * clearPipelineAudioRoutePreference, and getPipelineAudioSessionState to JS.
 */

#import "../../SherpaOnnx.h"
#import <React/RCTLog.h>
#import "../session/PaAudioSessionCoordinator.h"

@implementation SherpaOnnx (AudioSession)

- (void)configurePipelineAudioSession:(JS::NativeSherpaOnnx::SpecConfigurePipelineAudioSessionConfig &)config
                              resolve:(RCTPromiseResolveBlock)resolve
                               reject:(RCTPromiseRejectBlock)reject
{
  PaAudioSessionPolicy *policy = [[PaAudioSessionPolicy alloc] init];

  auto keepActiveWhenIdle = config.keepActiveWhenIdle();
  if (keepActiveWhenIdle.has_value()) {
    policy.keepActiveWhenIdle = keepActiveWhenIdle.value();
  }

  NSError *error = nil;
  BOOL ok = [[PaAudioSessionCoordinator shared] configurePolicy:policy error:&error];
  if (!ok && error) {
    reject(@"AUDIO_SESSION_CONFIG_ERROR", error.localizedDescription, error);
  } else {
    resolve(nil);
  }
}

- (void)setPipelineAudioRoutePreference:(NSString * _Nullable)inputDeviceId
                         outputDeviceId:(NSString * _Nullable)outputDeviceId
                                 resolve:(RCTPromiseResolveBlock)resolve
                                  reject:(RCTPromiseRejectBlock)reject
{
  NSString *normalizedInputDeviceId =
      [inputDeviceId isKindOfClass:[NSString class]] ? inputDeviceId : nil;
  NSString *normalizedOutputDeviceId =
      [outputDeviceId isKindOfClass:[NSString class]] ? outputDeviceId : nil;
  NSError *error = nil;
  BOOL ok = [[PaAudioSessionCoordinator shared] setRoutePreferenceInput:normalizedInputDeviceId
                                                                 output:normalizedOutputDeviceId
                                                                   error:&error];
  if (!ok && error) {
    reject(@"AUDIO_SESSION_ROUTE_ERROR", error.localizedDescription, error);
  } else {
    resolve(nil);
  }
}

- (void)clearPipelineAudioRoutePreference:(RCTPromiseResolveBlock)resolve
                                   reject:(RCTPromiseRejectBlock)reject
{
  [[PaAudioSessionCoordinator shared] clearRoutePreference];
  resolve(nil);
}

- (void)getPipelineAudioSessionState:(RCTPromiseResolveBlock)resolve
                              reject:(RCTPromiseRejectBlock)reject
{
  NSDictionary *snapshot = [[PaAudioSessionCoordinator shared] stateSnapshot];
  resolve(snapshot);
}

@end
