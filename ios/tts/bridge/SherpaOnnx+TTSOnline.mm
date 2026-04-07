#import "SherpaOnnx.h"

@interface SherpaOnnx (TTSOnlineInternal)
- (void)so_generateTtsStream:(NSString *)instanceId
                   requestId:(NSString *)requestId
                        text:(NSString *)text
                     options:(NSDictionary *)options
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject;
- (void)so_generateTtsStreamToFile:(NSString *)instanceId
                         requestId:(NSString *)requestId
                              text:(NSString *)text
                           options:(NSDictionary *)options
                       fileOptions:(NSDictionary *)fileOptions
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject;
- (void)so_cancelTtsStream:(NSString *)instanceId
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject;
- (void)so_startTtsPcmPlayer:(NSString *)instanceId
                   sampleRate:(double)sampleRate
                     channels:(double)channels
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject;
- (void)so_writeTtsPcmChunk:(NSString *)instanceId
                     samples:(NSArray<NSNumber *> *)samples
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject;
- (void)so_stopTtsPcmPlayer:(NSString *)instanceId
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject;
@end

@implementation SherpaOnnx (TTSOnline)

- (void)generateTtsStream:(NSString *)instanceId
                requestId:(NSString *)requestId
                     text:(NSString *)text
                  options:(NSDictionary *)options
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject {
  [self so_generateTtsStream:instanceId
                   requestId:requestId
                        text:text
                     options:options
                     resolve:resolve
                      reject:reject];
}

- (void)generateTtsStreamToFile:(NSString *)instanceId
                      requestId:(NSString *)requestId
                           text:(NSString *)text
                        options:(NSDictionary *)options
                    fileOptions:(NSDictionary *)fileOptions
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject {
  [self so_generateTtsStreamToFile:instanceId
                         requestId:requestId
                              text:text
                           options:options
                       fileOptions:fileOptions
                           resolve:resolve
                            reject:reject];
}

- (void)cancelTtsStream:(NSString *)instanceId
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject {
  [self so_cancelTtsStream:instanceId resolve:resolve reject:reject];
}

- (void)startTtsPcmPlayer:(NSString *)instanceId
                sampleRate:(double)sampleRate
                  channels:(double)channels
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject {
  [self so_startTtsPcmPlayer:instanceId
                  sampleRate:sampleRate
                    channels:channels
                     resolve:resolve
                      reject:reject];
}

- (void)writeTtsPcmChunk:(NSString *)instanceId
                  samples:(NSArray<NSNumber *> *)samples
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject {
  [self so_writeTtsPcmChunk:instanceId samples:samples resolve:resolve reject:reject];
}

- (void)stopTtsPcmPlayer:(NSString *)instanceId
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  [self so_stopTtsPcmPlayer:instanceId resolve:resolve reject:reject];
}

@end
