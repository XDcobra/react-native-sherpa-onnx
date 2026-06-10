#import "../../SherpaOnnx.h"
#import "SherpaOnnx+Assets.h"

@implementation SherpaOnnx (Assets)

- (NSString *)canonicalModelsDir {
  NSString *documentsPath = [NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES) firstObject];
  return [documentsPath stringByAppendingPathComponent:@"models"];
}

- (NSString *)resolveAssetPath:(NSString *)assetPath error:(NSError **)error {
  NSFileManager *fileManager = [NSFileManager defaultManager];
  NSString *folderName = [assetPath lastPathComponent];
  NSString *modelDir = [[self canonicalModelsDir] stringByAppendingPathComponent:folderName];

  BOOL isDirectory = NO;
  if ([fileManager fileExistsAtPath:modelDir isDirectory:&isDirectory] && isDirectory) {
    return modelDir;
  }

  NSString *bundleResourcePath = [[NSBundle mainBundle] resourcePath];
  NSString *sourcePath = [bundleResourcePath stringByAppendingPathComponent:assetPath];
  if ([fileManager fileExistsAtPath:sourcePath]) {
    return sourcePath;
  }

  NSString *bundlePath = [[NSBundle mainBundle] pathForResource:assetPath ofType:nil];
  if (bundlePath && [fileManager fileExistsAtPath:bundlePath]) {
    return bundlePath;
  }

  NSArray *pathComponents = [assetPath componentsSeparatedByString:@"/"];
  if (pathComponents.count > 1) {
    NSString *directory = pathComponents[0];
    for (NSInteger i = 1; i < pathComponents.count - 1; i++) {
      directory = [directory stringByAppendingPathComponent:pathComponents[i]];
    }
    NSString *resourceName = pathComponents.lastObject;
    bundlePath = [[NSBundle mainBundle] pathForResource:resourceName ofType:nil inDirectory:directory];
    if (bundlePath && [fileManager fileExistsAtPath:bundlePath]) {
      return bundlePath;
    }
  }

  if (error) {
    *error = [NSError errorWithDomain:@"SherpaOnnx"
                                 code:1
                             userInfo:@{NSLocalizedDescriptionKey: [NSString stringWithFormat:@"Bundled asset path not found: %@", assetPath]}];
  }
  return nil;
}

@end
