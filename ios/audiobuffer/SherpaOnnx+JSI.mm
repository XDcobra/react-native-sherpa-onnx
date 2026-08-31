/**
 * JSI install for SherpaOnnx audio buffers.
 *
 * Dual-path for public SDK peer react-native >= 0.73:
 * - New Arch / RN 0.75+: RCTTurboModuleWithJSIBindings (required on RN 0.87+;
 *   RCTCxxBridge type was removed there).
 * - Bridge / older apps: install via bridge.runtime when the property exists.
 */
#import "SherpaOnnx.h"

#import <jsi/jsi.h>

#import "SherpaOnnxJSI.h"

#if __has_include(<ReactCommon/RCTTurboModuleWithJSIBindings.h>)
#import <ReactCommon/RCTTurboModuleWithJSIBindings.h>
#define SHERPA_HAS_TM_JSI_BINDINGS 1
#endif

// Declared so we can call bridge.runtime without depending on RCTCxxBridge
// (removed as a public type in RN 0.87). Present at runtime on legacy bridges.
@interface RCTBridge (SherpaOnnxJSI)
- (void *)runtime;
@end

#if SHERPA_HAS_TM_JSI_BINDINGS
@interface SherpaOnnx () <RCTTurboModuleWithJSIBindings>
@end
#endif

@implementation SherpaOnnx (JSI)

static BOOL gSherpaJsiInstalled = NO;

static BOOL SherpaInstallJSIWithRuntime(facebook::jsi::Runtime *runtime)
{
  if (runtime == nullptr) {
    return NO;
  }
  @try {
    sherpa::installJSIBindings(*runtime);
    gSherpaJsiInstalled = YES;
    return YES;
  } @catch (...) {
    return NO;
  }
}

#if SHERPA_HAS_TM_JSI_BINDINGS
- (void)installJSIBindingsWithRuntime:(facebook::jsi::Runtime &)runtime
                          callInvoker:(const std::shared_ptr<facebook::react::CallInvoker> &)callInvoker
{
  (void)callInvoker;
  SherpaInstallJSIWithRuntime(&runtime);
}
#endif

- (BOOL)tryInstallJSIViaBridge
{
  RCTBridge *bridge = self.bridge;
  if (bridge == nil || ![bridge respondsToSelector:@selector(runtime)]) {
    return NO;
  }
  return SherpaInstallJSIWithRuntime(
      reinterpret_cast<facebook::jsi::Runtime *>([bridge runtime]));
}

- (BOOL)autoInstallJSI
{
  if (gSherpaJsiInstalled) {
    return YES;
  }
  // Bridge apps / older RN: install now. New Arch typically installs via
  // installJSIBindingsWithRuntime when the TurboModule is created.
  return [self tryInstallJSIViaBridge];
}

- (NSNumber *)installJSI
{
  return @([self autoInstallJSI]);
}

@end
