#import "../../SherpaOnnx.h"
#import <React/RCTLog.h>

#include "../core/AssetModelHintUtils.h"

@interface SherpaOnnx (AssetsPathsInternal)
- (NSString *)canonicalModelsDir;
@end

@implementation SherpaOnnx (Assets)

- (void)listAssetModels:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject {
  @try {
    NSFileManager *fileManager = [NSFileManager defaultManager];
    NSMutableSet *folderNames = [NSMutableSet set];

    NSString *canonicalDir = [self canonicalModelsDir];
    SherpaOnnxCollectModelFolderNames(fileManager, canonicalDir, folderNames);

    NSString *bundleModelsPath = [[[NSBundle mainBundle] resourcePath] stringByAppendingPathComponent:@"models"];
    SherpaOnnxCollectModelFolderNames(fileManager, bundleModelsPath, folderNames);

    NSMutableArray<NSDictionary *> *result = [NSMutableArray array];
    for (NSString *folder in [[folderNames allObjects] sortedArrayUsingSelector:@selector(compare:)]) {
      NSString *hint = SherpaOnnxInferModelHint(folder);
      [result addObject:@{ @"folder": folder, @"hint": hint }];
    }
    resolve(result);
  } @catch (NSException *exception) {
    NSString *errorMsg = [NSString stringWithFormat:@"Exception listing asset models: %@", exception.reason];
    reject(@"LIST_ASSETS_ERROR", errorMsg, nil);
  }
}

- (void)listModelsAtPath:(NSString *)path
               recursive:(BOOL)recursive
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  @try {
    if (!path || path.length == 0) {
      reject(@"PATH_REQUIRED", @"Path is required", nil);
      return;
    }

    NSFileManager *fileManager = [NSFileManager defaultManager];
    BOOL isDirectory = NO;
    BOOL exists = [fileManager fileExistsAtPath:path isDirectory:&isDirectory];
    if (!exists || !isDirectory) {
      resolve(@[]);
      return;
    }

    NSMutableArray<NSDictionary *> *result = [NSMutableArray array];
    NSMutableSet<NSString *> *seen = [NSMutableSet set];
    NSString *basePath = [path stringByStandardizingPath];

    if (!recursive) {
      NSError *error = nil;
      NSArray<NSString *> *items = [fileManager contentsOfDirectoryAtPath:basePath error:&error];
      if (error) {
        NSString *errorMsg = [NSString stringWithFormat:@"Failed to list directory: %@", error.localizedDescription];
        reject(@"LIST_MODELS_ERROR", errorMsg, error);
        return;
      }

      for (NSString *item in items) {
        if ([item hasPrefix:@"."]) {
          continue;
        }
        NSString *itemPath = [basePath stringByAppendingPathComponent:item];
        BOOL itemIsDir = NO;
        [fileManager fileExistsAtPath:itemPath isDirectory:&itemIsDir];
        if (itemIsDir && ![seen containsObject:item]) {
          NSString *hint = SherpaOnnxInferModelHint(item);
          [result addObject:@{ @"folder": item, @"hint": hint }];
          [seen addObject:item];
        }
      }
    } else {
      NSURL *baseURL = [NSURL fileURLWithPath:basePath];
      NSArray<NSURLResourceKey> *keys = @[ NSURLIsDirectoryKey ];
      NSDirectoryEnumerator *enumerator = [fileManager enumeratorAtURL:baseURL
                                            includingPropertiesForKeys:keys
                                                               options:NSDirectoryEnumerationSkipsHiddenFiles
                                                          errorHandler:^BOOL(NSURL *url, NSError *error) {
        RCTLogWarn(@"Failed to enumerate %@: %@", url.path, error.localizedDescription);
        return YES;
      }];

      for (NSURL *url in enumerator) {
        NSNumber *isDirValue = nil;
        [url getResourceValue:&isDirValue forKey:NSURLIsDirectoryKey error:nil];
        if (![isDirValue boolValue]) {
          continue;
        }

        NSString *fullPath = url.path;
        NSString *relativePath = nil;
        if ([fullPath hasPrefix:[basePath stringByAppendingString:@"/"]]) {
          relativePath = [fullPath substringFromIndex:basePath.length + 1];
        } else if ([fullPath isEqualToString:basePath]) {
          continue;
        } else {
          continue;
        }

        if (relativePath.length == 0 || [seen containsObject:relativePath]) {
          continue;
        }

        NSString *hint = SherpaOnnxInferModelHint(url.lastPathComponent);
        [result addObject:@{ @"folder": relativePath, @"hint": hint }];
        [seen addObject:relativePath];
      }
    }

    resolve(result);
  } @catch (NSException *exception) {
    NSString *errorMsg = [NSString stringWithFormat:@"Exception listing models: %@", exception.reason];
    reject(@"LIST_MODELS_ERROR", errorMsg, nil);
  }
}

@end
