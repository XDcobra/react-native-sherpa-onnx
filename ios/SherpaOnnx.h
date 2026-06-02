#import <React/RCTEventEmitter.h>

// Codegen policy:
// - Local Debug/dev: allow a minimal fallback protocol to keep iteration fast.
// - Release/CI: fail hard if the generated header is missing.
#if __has_include(<SherpaOnnxSpec/SherpaOnnxSpec.h>)
#import <SherpaOnnxSpec/SherpaOnnxSpec.h>
#elif DEBUG
@protocol NativeSherpaOnnxSpec
@end
#else
#error "Missing codegen header <SherpaOnnxSpec/SherpaOnnxSpec.h>. Run React Native codegen (yarn prepare) before building iOS."
#endif

@interface SherpaOnnx : RCTEventEmitter <NativeSherpaOnnxSpec>

+ (void)removeForegroundDownloadState:(NSString *)downloadId;

@end
