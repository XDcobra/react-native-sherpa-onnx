#import "../../SherpaOnnx.h"

@interface SherpaOnnx (Assets)

- (NSString *)canonicalModelsDir;
- (nullable NSString *)resolveAssetPath:(NSString *)assetPath error:(NSError **)error;

@end
