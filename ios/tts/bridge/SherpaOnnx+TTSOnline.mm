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
- (void)so_createPcmPlayer:(NSString *)playerId
                 sampleRate:(double)sampleRate
                   channels:(double)channels
                       feed:(NSString *)feed
              ttsInstanceId:(NSString *)ttsInstanceId
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject;
- (void)so_writePcmChunk:(NSString *)playerId
                  samples:(NSArray<NSNumber *> *)samples
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject;
- (void)so_pausePcmPlayer:(NSString *)playerId
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject;
- (void)so_resumePcmPlayer:(NSString *)playerId
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject;
- (void)so_destroyPcmPlayer:(NSString *)playerId
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

- (void)createPcmPlayer:(NSString *)playerId
              sampleRate:(double)sampleRate
                channels:(double)channels
                    feed:(NSString *)feed
           ttsInstanceId:(NSString *)ttsInstanceId
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  [self so_createPcmPlayer:playerId
                sampleRate:sampleRate
                  channels:channels
                      feed:feed
             ttsInstanceId:ttsInstanceId
                   resolve:resolve
                    reject:reject];
}

- (void)writePcmChunk:(NSString *)playerId
              samples:(NSArray<NSNumber *> *)samples
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject {
  [self so_writePcmChunk:playerId samples:samples resolve:resolve reject:reject];
}

- (void)pausePcmPlayer:(NSString *)playerId
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject {
  [self so_pausePcmPlayer:playerId resolve:resolve reject:reject];
}

- (void)resumePcmPlayer:(NSString *)playerId
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject {
  [self so_resumePcmPlayer:playerId resolve:resolve reject:reject];
}

- (void)destroyPcmPlayer:(NSString *)playerId
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject {
  [self so_destroyPcmPlayer:playerId resolve:resolve reject:reject];
}

@end
