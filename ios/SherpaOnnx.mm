/*
 * Core SherpaOnnx module helpers (paths, assets, and event registration).
 * Feature-specific methods are implemented in SherpaOnnx+STT.mm and SherpaOnnx+TTS.mm.
 */

#import "SherpaOnnx.h"
#import "SherpaOnnxArchiveHelper.h"
#import <React/RCTLog.h>

@implementation SherpaOnnx

- (NSArray<NSString *> *)supportedEvents
{
    return @[ @"ttsStreamChunk", @"ttsStreamEnd", @"ttsStreamError", @"extractTarBz2Progress" ];
}

- (void)resolveModelPath:(NSDictionary *)config
            withResolver:(RCTPromiseResolveBlock)resolve
            withRejecter:(RCTPromiseRejectBlock)reject
{
    NSString *type = config[@"type"] ?: @"auto";
    NSString *path = config[@"path"];

    if (!path) {
        reject(@"PATH_REQUIRED", @"Path is required", nil);
        return;
    }

    NSError *error = nil;
    NSString *resolvedPath = nil;

    if ([type isEqualToString:@"asset"]) {
        resolvedPath = [self resolveAssetPath:path error:&error];
    } else if ([type isEqualToString:@"file"]) {
        resolvedPath = [self resolveFilePath:path error:&error];
    } else if ([type isEqualToString:@"auto"]) {
        resolvedPath = [self resolveAutoPath:path error:&error];
    } else {
        NSString *errorMsg = [NSString stringWithFormat:@"Unknown path type: %@", type];
        reject(@"INVALID_TYPE", errorMsg, nil);
        return;
    }

    if (error) {
        reject(@"PATH_RESOLVE_ERROR", error.localizedDescription, error);
        return;
    }

    resolve(resolvedPath);
}

- (NSString *)resolveAssetPath:(NSString *)assetPath error:(NSError **)error
{
    NSFileManager *fileManager = [NSFileManager defaultManager];

    // First, try to find directly in bundle (for folder references)
    NSString *bundlePath = [[NSBundle mainBundle] pathForResource:assetPath ofType:nil];

    if (bundlePath && [fileManager fileExistsAtPath:bundlePath]) {
        return bundlePath;
    }

    // Try with directory structure (for resources in subdirectories)
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

    // If not found in bundle, try to copy from bundle to Documents
    NSString *documentsPath = [NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES) firstObject];
    NSString *targetDir = [documentsPath stringByAppendingPathComponent:@"models"];
    NSString *modelDir = [targetDir stringByAppendingPathComponent:[assetPath lastPathComponent]];

    // Check if already copied
    if ([fileManager fileExistsAtPath:modelDir]) {
        return modelDir;
    }

    // Try to find and copy from bundle resource path
    NSString *bundleResourcePath = [[NSBundle mainBundle] resourcePath];
    NSString *sourcePath = [bundleResourcePath stringByAppendingPathComponent:assetPath];

    if ([fileManager fileExistsAtPath:sourcePath]) {
        NSError *copyError = nil;
        [fileManager createDirectoryAtPath:targetDir withIntermediateDirectories:YES attributes:nil error:&copyError];
        if (copyError) {
            if (error) *error = copyError;
            return nil;
        }

        // Copy recursively if it's a directory
        BOOL isDirectory = NO;
        [fileManager fileExistsAtPath:sourcePath isDirectory:&isDirectory];

        if (isDirectory) {
            [fileManager copyItemAtPath:sourcePath toPath:modelDir error:&copyError];
        } else {
            [fileManager copyItemAtPath:sourcePath toPath:modelDir error:&copyError];
        }

        if (copyError) {
            if (error) *error = copyError;
            return nil;
        }

        return modelDir;
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
    // Try asset first
    NSError *assetError = nil;
    NSString *resolvedPath = [self resolveAssetPath:path error:&assetError];

    if (resolvedPath) {
        return resolvedPath;
    }

    // If asset fails, try file system
    NSError *fileError = nil;
    resolvedPath = [self resolveFilePath:path error:&fileError];

    if (resolvedPath) {
        return resolvedPath;
    }

    // Both failed
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

- (void)testSherpaInitWithResolver:(RCTPromiseResolveBlock)resolve
                      withRejecter:(RCTPromiseRejectBlock)reject
{
    @try {
        resolve(@"Sherpa ONNX loaded!");
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception during test: %@", exception.reason];
        reject(@"TEST_ERROR", errorMsg, nil);
    }
}

- (void)extractTarBz2:(NSString *)sourcePath
           targetPath:(NSString *)targetPath
                force:(BOOL)force
         withResolver:(RCTPromiseResolveBlock)resolve
         withRejecter:(RCTPromiseRejectBlock)reject
{
    SherpaOnnxArchiveHelper *helper = [SherpaOnnxArchiveHelper new];
    NSDictionary *result = [helper extractTarBz2:sourcePath
                                     targetPath:targetPath
                                          force:force
                                       progress:^(long long bytes, long long totalBytes, double percent) {
        [self sendEventWithName:@"extractTarBz2Progress"
                           body:@{ @"bytes": @(bytes),
                                   @"totalBytes": @(totalBytes),
                                   @"percent": @(percent) }];
    }];
    resolve(result);
}

- (void)cancelExtractTarBz2:(RCTPromiseResolveBlock)resolve
               withRejecter:(RCTPromiseRejectBlock)reject
{
    [SherpaOnnxArchiveHelper cancelExtractTarBz2];
    resolve(nil);
}

- (void)computeFileSha256:(NSString *)filePath
             withResolver:(RCTPromiseResolveBlock)resolve
             withRejecter:(RCTPromiseRejectBlock)reject
{
    SherpaOnnxArchiveHelper *helper = [SherpaOnnxArchiveHelper new];
    NSError *error = nil;
    NSString *digest = [helper computeFileSha256:filePath error:&error];
    if (error || !digest) {
        reject(@"CHECKSUM_ERROR", error.localizedDescription ?: @"Failed to compute SHA-256", error);
        return;
    }
    resolve(digest);
}

- (void)listAssetModels:(RCTPromiseResolveBlock)resolve
          withRejecter:(RCTPromiseRejectBlock)reject
{
    @try {
        NSFileManager *fileManager = [NSFileManager defaultManager];
        NSMutableArray<NSString *> *modelFolders = [NSMutableArray array];

        // Get the main bundle resource path
        NSString *bundleResourcePath = [[NSBundle mainBundle] resourcePath];
        NSString *modelsPath = [bundleResourcePath stringByAppendingPathComponent:@"models"];

        // Check if models directory exists
        BOOL isDirectory = NO;
        BOOL exists = [fileManager fileExistsAtPath:modelsPath isDirectory:&isDirectory];

        if (exists && isDirectory) {
            NSError *error = nil;
            NSArray<NSString *> *items = [fileManager contentsOfDirectoryAtPath:modelsPath error:&error];

            if (error) {
                RCTLogWarn(@"Could not list models directory: %@", error.localizedDescription);
            } else {
                // Filter to only include directories
                for (NSString *item in items) {
                    // Skip hidden files (starting with .)
                    if ([item hasPrefix:@"."]) {
                        continue;
                    }

                    NSString *itemPath = [modelsPath stringByAppendingPathComponent:item];
                    BOOL itemIsDirectory = NO;
                    [fileManager fileExistsAtPath:itemPath isDirectory:&itemIsDirectory];

                    if (itemIsDirectory) {
                        [modelFolders addObject:item];
                    }
                }
            }
        } else {
            RCTLogWarn(@"Models directory not found at: %@", modelsPath);
        }

        NSMutableArray<NSDictionary *> *result = [NSMutableArray array];
        for (NSString *folder in modelFolders) {
            NSString *hint = [self inferModelHint:folder];
            [result addObject:@{ @"folder": folder, @"hint": hint }];
        }
        resolve(result);
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception listing asset models: %@", exception.reason];
        reject(@"LIST_ASSETS_ERROR", errorMsg, nil);
    }
}

// Infer a high-level model type hint from a folder name.
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
