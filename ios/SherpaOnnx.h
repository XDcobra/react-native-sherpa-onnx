#import <React/RCTEventEmitter.h>

// The codegen-generated header `SherpaOnnxSpec/SherpaOnnxSpec.h` is produced
// by React Native's codegen. In some build setups (CI or a fresh checkout)
// it may be missing until the iOS codegen step runs. Guard the import so
// the library can still compile (useful for IDEs and quick static checks).
#if __has_include(<SherpaOnnxSpec/SherpaOnnxSpec.h>)
#import <SherpaOnnxSpec/SherpaOnnxSpec.h>
#else
// Minimal fallback to allow compilation before codegen runs.
@protocol NativeSherpaOnnxSpec
@end
#endif

@interface SherpaOnnx : RCTEventEmitter <NativeSherpaOnnxSpec>

@end
