#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <dispatch/dispatch.h>

#include "VideoRegistry.h"

#if !TARGET_OS_OSX

using sherpa_onnx::video::MemoryPressureLevel;
using sherpa_onnx::video::VideoRegistry;

@interface SherpaVideoMemoryPressure : NSObject
@end

@implementation SherpaVideoMemoryPressure {
  dispatch_source_t _src;
}

+ (instancetype)shared {
  static SherpaVideoMemoryPressure *inst;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    inst = [[SherpaVideoMemoryPressure alloc] init];
  });
  return inst;
}

- (instancetype)init {
  if ((self = [super init])) {
    NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
    [nc addObserver:self
           selector:@selector(onWarning)
               name:UIApplicationDidReceiveMemoryWarningNotification
             object:nil];
    _src = dispatch_source_create(DISPATCH_SOURCE_TYPE_MEMORYPRESSURE, 0,
                                  DISPATCH_MEMORYPRESSURE_WARN |
                                      DISPATCH_MEMORYPRESSURE_CRITICAL,
                                  dispatch_get_main_queue());
    dispatch_source_set_event_handler(_src, ^{
      unsigned long data = dispatch_source_get_data(self->_src);
      auto level = (data & DISPATCH_MEMORYPRESSURE_CRITICAL)
                       ? MemoryPressureLevel::Critical
                       : MemoryPressureLevel::Moderate;
      VideoRegistry::Instance().OnMemoryPressure(level);
    });
    dispatch_resume(_src);
  }
  return self;
}

- (void)onWarning {
  VideoRegistry::Instance().OnMemoryPressure(MemoryPressureLevel::Critical);
}

@end

void SherpaVideoInstallMemoryPressureObserver(void) {
  (void)[SherpaVideoMemoryPressure shared];
}

#else

void SherpaVideoInstallMemoryPressureObserver(void) {}

#endif
