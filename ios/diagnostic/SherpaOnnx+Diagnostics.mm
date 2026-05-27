#import "SherpaOnnx.h"

#include "../../android/src/main/cpp/jni/diagnostic/NativeDiagnostic.h"

extern "C" {
const char* sherpa_diag_get_snapshot_json(void);
void sherpa_diag_set_enabled(int enabled);
void sherpa_diag_set_install_signal_handler(int install);
void sherpa_diag_init(int installSignalHandler);
}

@implementation SherpaOnnx (Diagnostics)

- (void)getNativeDiagnosticSnapshot:(RCTPromiseResolveBlock)resolve
                             reject:(RCTPromiseRejectBlock)reject
{
  @try {
    const char* json = sherpa_diag_get_snapshot_json();
    if (!json) {
      resolve(@"{\"enabled\":true,\"signalHandlerInstalled\":false,\"entries\":[]}");
      return;
    }
    resolve([NSString stringWithUTF8String:json]);
  } @catch (NSException* exception) {
    reject(@"DIAGNOSTIC_ERROR", exception.reason, nil);
  }
}

- (void)configureNativeDiagnostics:(NSDictionary*)config
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject
{
  @try {
    NSNumber* enabledNum = config[@"enabled"];
    NSNumber* installHandlerNum = config[@"installSignalHandler"];
    const BOOL enabled = enabledNum != nil ? enabledNum.boolValue : YES;
    const BOOL installHandler =
        installHandlerNum != nil ? installHandlerNum.boolValue : YES;
    sherpa_diag_set_enabled(enabled ? 1 : 0);
    sherpa_diag_set_install_signal_handler(installHandler ? 1 : 0);
    sherpa_diag_init(installHandler ? 1 : 0);
    resolve(nil);
  } @catch (NSException* exception) {
    reject(@"DIAGNOSTIC_ERROR", exception.reason, nil);
  }
}

@end
