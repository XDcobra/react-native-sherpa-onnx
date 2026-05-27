#import "SherpaOnnx.h"

@interface SherpaOnnx (TTSCommonInternal)
- (void)so_initializeTts:(NSString *)instanceId
                 options:(NSDictionary *)options
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject;
- (void)so_detectTtsModel:(NSString *)modelDir
                assetName:(NSString *)assetName
                modelType:(NSString *)modelType
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject;
- (void)so_getTtsSampleRate:(NSString *)instanceId
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject;
- (void)so_getTtsNumSpeakers:(NSString *)instanceId
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject;
- (void)so_unloadTts:(NSString *)instanceId
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject;
@end

@implementation SherpaOnnx (TTSCommon)

- (void)initializeTts:(NSString *)instanceId
              options:(NSDictionary *)options
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject {
  [self so_initializeTts:instanceId options:options resolve:resolve reject:reject];
}

- (void)detectTtsModel:(NSString *)modelDir
             assetName:(NSString *)assetName
             modelType:(NSString *)modelType
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject {
  [self so_detectTtsModel:modelDir assetName:assetName modelType:modelType resolve:resolve reject:reject];
}

- (void)getTtsSampleRate:(NSString *)instanceId
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  [self so_getTtsSampleRate:instanceId resolve:resolve reject:reject];
}

- (void)getTtsNumSpeakers:(NSString *)instanceId
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject {
  [self so_getTtsNumSpeakers:instanceId resolve:resolve reject:reject];
}

- (void)unloadTts:(NSString *)instanceId
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject {
  [self so_unloadTts:instanceId resolve:resolve reject:reject];
}

@end
