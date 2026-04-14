#import "../../SherpaOnnx.h"

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
                             userInfo:@{NSLocalizedDescriptionKey: [NSString stringWithFormat:@"Asset path not found: %@", assetPath]}];
  }
  return nil;
}

- (NSString *)resolveFilePath:(NSString *)filePath error:(NSError **)error {
  NSFileManager *fileManager = [NSFileManager defaultManager];
  BOOL isDirectory = NO;
  BOOL exists = [fileManager fileExistsAtPath:filePath isDirectory:&isDirectory];

  if (!exists) {
    if (error) {
      *error = [NSError errorWithDomain:@"SherpaOnnx"
                                   code:2
                               userInfo:@{NSLocalizedDescriptionKey: [NSString stringWithFormat:@"File path does not exist: %@", filePath]}];
    }
    return nil;
  }

  if (!isDirectory) {
    if (error) {
      *error = [NSError errorWithDomain:@"SherpaOnnx"
                                   code:3
                               userInfo:@{NSLocalizedDescriptionKey: [NSString stringWithFormat:@"Path is not a directory: %@", filePath]}];
    }
    return nil;
  }

  return [filePath stringByStandardizingPath];
}

- (NSString *)resolveAutoPath:(NSString *)path error:(NSError **)error {
  NSError *assetError = nil;
  NSString *resolvedPath = [self resolveAssetPath:path error:&assetError];
  if (resolvedPath) {
    return resolvedPath;
  }

  NSError *fileError = nil;
  resolvedPath = [self resolveFilePath:path error:&fileError];
  if (resolvedPath) {
    return resolvedPath;
  }

  if (error) {
    NSString *errorMessage = [NSString stringWithFormat:@"Path not found as asset or file: %@. Asset error: %@, File error: %@",
                               path,
                               assetError.localizedDescription ?: @"Unknown",
                               fileError.localizedDescription ?: @"Unknown"];
    *error = [NSError errorWithDomain:@"SherpaOnnx"
                                 code:4
                             userInfo:@{NSLocalizedDescriptionKey: errorMessage}];
  }
  return nil;
}

@end
