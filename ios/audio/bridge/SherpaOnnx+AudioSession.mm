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

- (void)configurePipelineAudioSession:(NSDictionary *)config
                              resolve:(RCTPromiseResolveBlock)resolve
                               reject:(RCTPromiseRejectBlock)reject
{
  PaAudioSessionPolicy *policy = [[PaAudioSessionPolicy alloc] init];

  if ([config[@"keepActiveWhenIdle"] isKindOfClass:[NSNumber class]]) {
    policy.keepActiveWhenIdle = [config[@"keepActiveWhenIdle"] boolValue];
  }

  NSError *error = nil;
  BOOL ok = [[PaAudioSessionCoordinator shared] configurePolicy:policy error:&error];
  if (!ok && error) {
    reject(@"AUDIO_SESSION_CONFIG_ERROR", error.localizedDescription, error);
  } else {
    resolve(nil);
  }
}

- (void)setPipelineAudioRoutePreference:(NSString *)inputDeviceId
                         outputDeviceId:(NSString *)outputDeviceId
                                resolve:(RCTPromiseResolveBlock)resolve
                                 reject:(RCTPromiseRejectBlock)reject
{
  NSError *error = nil;
  BOOL ok = [[PaAudioSessionCoordinator shared] setRoutePreferenceInput:inputDeviceId
                                                                 output:outputDeviceId
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
