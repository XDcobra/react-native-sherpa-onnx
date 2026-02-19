#import <React/RCTBridgeModule.h>
#import <React/RCTBridgeMethod.h>

@interface CpuInfo : NSObject <RCTBridgeModule>
@end

@implementation CpuInfo

RCT_EXPORT_MODULE(CpuInfo)

RCT_EXPORT_METHOD(getCpuCoreCount:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  NSInteger count = [[NSProcessInfo processInfo] processorCount];
  resolve(@(count));
}

@end
