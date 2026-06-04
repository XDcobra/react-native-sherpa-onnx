#import "../../SherpaOnnx.h"
#import "../core/OdrDelivery.h"
#import <React/RCTBridgeModule.h>

@implementation SherpaOnnx (OdrDelivery)

- (void)fetchAssetPack:(NSString *)packName
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  [[SherpaOnnxOdrDelivery shared] fetchAssetPack:packName
                                         resolve:resolve
                                          reject:reject];
}

- (void)ensureAssetPackReady:(NSString *)packName
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject
{
  __weak SherpaOnnx *weakSelf = self;
  [[SherpaOnnxOdrDelivery shared]
      ensureAssetPackReady:packName
         progressHandler:^(NSDictionary *state) {
           SherpaOnnx *strongSelf = weakSelf;
           if (strongSelf) {
             [strongSelf sendEventWithName:@"sherpaAssetPackDeliveryProgress" body:state];
           }
         }
                 resolve:resolve
                  reject:reject];
}

- (void)getAssetPackState:(NSString *)packName
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  [[SherpaOnnxOdrDelivery shared] getAssetPackState:packName
                                            resolve:resolve
                                             reject:reject];
}

- (void)removeAssetPack:(NSString *)packName
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  [[SherpaOnnxOdrDelivery shared] removeAssetPack:packName
                                           resolve:resolve
                                            reject:reject];
}

- (void)listOdrDeliverySnapshot:(NSString *)tag
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject
{
  [[SherpaOnnxOdrDelivery shared] listOdrDeliverySnapshot:tag
                                                  resolve:resolve
                                                   reject:reject];
}

@end
