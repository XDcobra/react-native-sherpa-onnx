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

@end
