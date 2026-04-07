#import "SherpaOnnx.h"

@interface SherpaOnnx (TTSCommonInternal)
- (void)so_initializeTts:(NSString *)instanceId
                modelDir:(NSString *)modelDir
               modelType:(NSString *)modelType
              numThreads:(double)numThreads
                   debug:(BOOL)debug
              noiseScale:(NSNumber *)noiseScale
             noiseScaleW:(NSNumber *)noiseScaleW
             lengthScale:(NSNumber *)lengthScale
                ruleFsts:(NSString *)ruleFsts
                ruleFars:(NSString *)ruleFars
         maxNumSentences:(NSNumber *)maxNumSentences
            silenceScale:(NSNumber *)silenceScale
                provider:(NSString *)provider
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject;
- (void)so_detectTtsModel:(NSString *)modelDir
                modelType:(NSString *)modelType
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject;
- (void)so_batchTtsCatalogHints:(NSArray *)ids
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
             modelDir:(NSString *)modelDir
            modelType:(NSString *)modelType
           numThreads:(double)numThreads
                debug:(BOOL)debug
           noiseScale:(NSNumber *)noiseScale
          noiseScaleW:(NSNumber *)noiseScaleW
          lengthScale:(NSNumber *)lengthScale
             ruleFsts:(NSString *)ruleFsts
             ruleFars:(NSString *)ruleFars
      maxNumSentences:(NSNumber *)maxNumSentences
         silenceScale:(NSNumber *)silenceScale
             provider:(NSString *)provider
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject {
  [self so_initializeTts:instanceId
                modelDir:modelDir
               modelType:modelType
              numThreads:numThreads
                   debug:debug
              noiseScale:noiseScale
             noiseScaleW:noiseScaleW
             lengthScale:lengthScale
                ruleFsts:ruleFsts
                ruleFars:ruleFars
         maxNumSentences:maxNumSentences
            silenceScale:silenceScale
                provider:provider
                 resolve:resolve
                  reject:reject];
}

- (void)detectTtsModel:(NSString *)modelDir
             modelType:(NSString *)modelType
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject {
  [self so_detectTtsModel:modelDir modelType:modelType resolve:resolve reject:reject];
}

- (void)batchTtsCatalogHints:(NSArray *)ids
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject {
  [self so_batchTtsCatalogHints:ids resolve:resolve reject:reject];
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
