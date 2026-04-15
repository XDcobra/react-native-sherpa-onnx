#import "SherpaOnnx.h"

@interface SherpaOnnx (TTSOfflineInternal)
- (void)so_updateTtsParams:(NSString *)instanceId
                noiseScale:(NSNumber *)noiseScale
               noiseScaleW:(NSNumber *)noiseScaleW
               lengthScale:(NSNumber *)lengthScale
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject;
- (void)so_synthesizeTts:(NSString *)instanceId
         textInBufferId:(NSString *)textInBufferId
        audioOutBufferId:(NSString *)audioOutBufferId
                 options:(NSDictionary *)options
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject;
@end

@implementation SherpaOnnx (TTSOffline)

- (void)updateTtsParams:(NSString *)instanceId
             noiseScale:(NSNumber *)noiseScale
            noiseScaleW:(NSNumber *)noiseScaleW
            lengthScale:(NSNumber *)lengthScale
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject {
  [self so_updateTtsParams:instanceId
                noiseScale:noiseScale
               noiseScaleW:noiseScaleW
               lengthScale:lengthScale
                   resolve:resolve
                    reject:reject];
}

- (void)synthesizeTts:(NSString *)instanceId
      textInBufferId:(NSString *)textInBufferId
     audioOutBufferId:(NSString *)audioOutBufferId
              options:(NSDictionary *)options
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject {
  [self so_synthesizeTts:instanceId
          textInBufferId:textInBufferId
         audioOutBufferId:audioOutBufferId
                  options:options
                  resolve:resolve
                   reject:reject];
}

@end
