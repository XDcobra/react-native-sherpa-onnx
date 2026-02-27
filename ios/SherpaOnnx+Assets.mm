/**
 * SherpaOnnx+Assets.mm
 *
 * Purpose: Asset and model path logic for the SherpaOnnx module: canonical models directory,
 * resolveAssetPath, resolveFilePath, resolveAutoPath, listAssetModels, listModelsAtPath, and
 * inferModelHint. Keeps the main module file focused; aligns with Android SherpaOnnxAssetHelper.kt.
 */

#import "SherpaOnnx.h"
#import <React/RCTLog.h>

// Collects directory names (model folder names) under path into the set. Skips hidden items.
static void collectModelFolderNames(NSFileManager *fileManager, NSString *path, NSMutableSet *outNames)
{
    BOOL isDirectory = NO;
    if (![fileManager fileExistsAtPath:path isDirectory:&isDirectory] || !isDirectory) {
        return;
    }
    NSError *err = nil;
    NSArray<NSString *> *items = [fileManager contentsOfDirectoryAtPath:path error:&err];
    if (err) {
        return;
    }
    for (NSString *item in items) {
        if ([item hasPrefix:@"."]) {
            continue;
        }
        NSString *itemPath = [path stringByAppendingPathComponent:item];
        BOOL itemIsDir = NO;
        [fileManager fileExistsAtPath:itemPath isDirectory:&itemIsDir];
        if (itemIsDir) {
            [outNames addObject:item];
        }
    }
}

@implementation SherpaOnnx (Assets)

// Documents/models: used for downloaded assets and for listAssetModels.
- (NSString *)canonicalModelsDir
{
    NSString *documentsPath = [NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES) firstObject];
    return [documentsPath stringByAppendingPathComponent:@"models"];
}

- (NSString *)resolveAssetPath:(NSString *)assetPath error:(NSError **)error
{
    NSFileManager *fileManager = [NSFileManager defaultManager];
    NSString *folderName = [assetPath lastPathComponent];
    NSString *modelDir = [[self canonicalModelsDir] stringByAppendingPathComponent:folderName];

    // 1. Documents/models/<folder>: downloaded assets (no copy; bundle is read in place).
    BOOL isDirectory = NO;
    if ([fileManager fileExistsAtPath:modelDir isDirectory:&isDirectory] && isDirectory) {
        return modelDir;
    }

    // 2. Bundle (resourcePath/assetPath): return path directly; do not copy.
    NSString *bundleResourcePath = [[NSBundle mainBundle] resourcePath];
    NSString *sourcePath = [bundleResourcePath stringByAppendingPathComponent:assetPath];
    if ([fileManager fileExistsAtPath:sourcePath]) {
        return sourcePath;
    }

    // 3. Fallback: pathForResource / inDirectory for non-standard bundle layouts.
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

- (NSString *)resolveFilePath:(NSString *)filePath error:(NSError **)error
{
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

- (NSString *)resolveAutoPath:(NSString *)path error:(NSError **)error
{
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

- (void)listAssetModels:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject
{
    @try {
        NSFileManager *fileManager = [NSFileManager defaultManager];
        NSMutableSet *folderNames = [NSMutableSet set];

        NSString *canonicalDir = [self canonicalModelsDir];
        collectModelFolderNames(fileManager, canonicalDir, folderNames);

        NSString *bundleModelsPath = [[[NSBundle mainBundle] resourcePath] stringByAppendingPathComponent:@"models"];
        collectModelFolderNames(fileManager, bundleModelsPath, folderNames);

        NSMutableArray<NSDictionary *> *result = [NSMutableArray array];
        for (NSString *folder in [[folderNames allObjects] sortedArrayUsingSelector:@selector(compare:)]) {
            NSString *hint = [self inferModelHint:folder];
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
             reject:(RCTPromiseRejectBlock)reject
{
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
                    NSString *hint = [self inferModelHint:item];
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

                NSString *hintName = url.lastPathComponent;
                NSString *hint = [self inferModelHint:hintName];
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

- (NSString *)inferModelHint:(NSString *)folderName
{
    NSString *name = [folderName lowercaseString];
    NSArray<NSString *> *sttHints = @[
        @"zipformer",
        @"paraformer",
        @"nemo",
        @"parakeet",
        @"whisper",
        @"wenet",
        @"sensevoice",
        @"sense-voice",
        @"sense",
        @"funasr",
        @"transducer",
        @"ctc",
        @"asr"
    ];
    NSArray<NSString *> *ttsHints = @[
        @"vits",
        @"piper",
        @"matcha",
        @"kokoro",
        @"kitten",
        @"pocket",
        @"zipvoice",
        @"melo",
        @"coqui",
        @"mms",
        @"tts"
    ];

    BOOL isStt = NO;
    for (NSString *hint in sttHints) {
        if ([name containsString:hint]) {
            isStt = YES;
            break;
        }
    }

    BOOL isTts = NO;
    for (NSString *hint in ttsHints) {
        if ([name containsString:hint]) {
            isTts = YES;
            break;
        }
    }

    if (isStt && isTts) {
        return @"unknown";
    }

    if (isStt) {
        return @"stt";
    }

    if (isTts) {
        return @"tts";
    }

    return @"unknown";
}

@end
