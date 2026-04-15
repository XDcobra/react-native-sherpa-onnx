#import "SherpaOnnx.h"

#import <React/RCTBridge+Private.h>
#import <jsi/jsi.h>

#import "SherpaOnnxJSI.h"

@implementation SherpaOnnx (JSI)

- (BOOL)autoInstallJSI
{
  @try {
    RCTCxxBridge *cxxBridge = (RCTCxxBridge *)self.bridge;
    if (cxxBridge == nil || cxxBridge.runtime == nil) {
      return NO;
    }

    auto *runtime = (facebook::jsi::Runtime *)cxxBridge.runtime;
    if (runtime == nullptr) {
      return NO;
    }

    sherpa::installJSIBindings(*runtime);
    return YES;
  } @catch (...) {
    return NO;
  }
}

- (NSNumber *)installJSI
{
  return @([self autoInstallJSI]);
}

@end
