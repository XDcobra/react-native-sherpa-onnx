/*
 * Core SherpaOnnx module helpers (paths, assets, and event registration).
 * Feature-specific methods are implemented in SherpaOnnx+STT.mm and SherpaOnnx+TTS.mm.
 */

#import "SherpaOnnx.h"
#import "SherpaOnnxArchiveHelper.h"
#import <React/RCTLog.h>
#if __has_include("SherpaOnnx-Swift.h")
#import "SherpaOnnx-Swift.h"
#endif

@implementation SherpaOnnx

+ (NSString *)moduleName
{
    return @"SherpaOnnx";
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
    return std::make_shared<facebook::react::NativeSherpaOnnxSpecJSI>(params);
}

- (NSArray<NSString *> *)supportedEvents
{
    return @[ @"ttsStreamChunk", @"ttsStreamEnd", @"ttsStreamError", @"extractTarBz2Progress" ];
}

- (void)resolveModelPath:(JS::NativeSherpaOnnx::SpecResolveModelPathConfig &)config
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
    NSString *type = config.type() ?: @"auto";
    NSString *path = config.path();

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

- (void)testSherpaInit:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
    @try {
        resolve(@"Sherpa ONNX loaded!");
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception during test: %@", exception.reason];
        reject(@"TEST_ERROR", errorMsg, nil);
    }
}

// QNN (Qualcomm NPU) is Android-only; on iOS the build never has QNN support.
- (void)getQnnSupport:(NSString *)modelBase64
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
    resolve(@{ @"providerCompiled": @NO, @"hasAccelerator": @NO, @"canInit": @NO });
}

// NNAPI is Android-only; on iOS we always return no support.
- (void)getNnapiSupport:(NSString *)modelBase64
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
    resolve(@{ @"providerCompiled": @NO, @"hasAccelerator": @NO, @"canInit": @NO });
}

// XNNPACK support: stub on iOS (could be extended to check ORT providers and session init).
- (void)getXnnpackSupport:(NSString *)modelBase64
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
    resolve(@{ @"providerCompiled": @NO, @"hasAccelerator": @NO, @"canInit": @NO });
}

// Core ML support (iOS): providerCompiled = true (Core ML on iOS 11+), hasAccelerator = Apple Neural Engine, canInit = session test (stub false unless ORT linked).
- (void)getCoreMlSupport:(NSString *)modelBase64
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
    BOOL hasANE = NO;
#if __has_include("SherpaOnnx-Swift.h")
    if ([SherpaOnnxCoreMLHelper respondsToSelector:@selector(hasAppleNeuralEngine)]) {
        hasANE = [SherpaOnnxCoreMLHelper hasAppleNeuralEngine];
    }
#endif
    resolve(@{
        @"providerCompiled": @YES,  // Core ML always present on iOS 11+
        @"hasAccelerator": hasANE ? @YES : @NO,
        @"canInit": @NO,  // Would require ORT session with CoreML EP; not implemented here
    });
}

- (void)extractTarBz2:(NSString *)sourcePath
           targetPath:(NSString *)targetPath
                force:(BOOL)force
         resolve:(RCTPromiseResolveBlock)resolve
         reject:(RCTPromiseRejectBlock)reject
{
    SherpaOnnxArchiveHelper *helper = [SherpaOnnxArchiveHelper new];
    NSDictionary *result = [helper extractTarBz2:sourcePath
                                     targetPath:targetPath
                                          force:force
                                       progress:^(long long bytes, long long totalBytes, double percent) {
        [self sendEventWithName:@"extractTarBz2Progress"
                           body:@{ @"sourcePath": sourcePath,
                                   @"bytes": @(bytes),
                                   @"totalBytes": @(totalBytes),
                                   @"percent": @(percent) }];
    }];
    resolve(result);
}

- (void)cancelExtractTarBz2:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
    [SherpaOnnxArchiveHelper cancelExtractTarBz2];
    resolve(nil);
}

- (void)computeFileSha256:(NSString *)filePath
             resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject
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

- (void)listAssetModels:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject
{
    @try {
        NSFileManager *fileManager = [NSFileManager defaultManager];
        NSMutableSet *folderNames = [NSMutableSet set];

        // List from Documents/models: downloaded assets
        NSString *canonicalDir = [self canonicalModelsDir];
        collectModelFolderNames(fileManager, canonicalDir, folderNames);

        // List from bundle (App.app/models): bundled assets (read in place, no copy)
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

- (void)getAssetPackPath:(NSString *)packName
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
    // Play Asset Delivery is Android-only; on iOS there is no asset pack path.
    resolve([NSNull null]);
}

- (void)convertAudioToFormat:(NSString *)inputPath
                 outputPath:(NSString *)outputPath
                     format:(NSString *)format
         outputSampleRateHz:(NSNumber *)outputSampleRateHz
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
    reject(@"UNSUPPORTED", @"convertAudioToFormat is not implemented on iOS", nil);
}

- (void)convertAudioToWav16k:(NSString *)inputPath
                 outputPath:(NSString *)outputPath
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
    reject(@"UNSUPPORTED", @"convertAudioToWav16k is not implemented on iOS", nil);
}

- (void)getAvailableProviders:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject
{
    @try {
        NSMutableArray<NSString *> *providers = [NSMutableArray arrayWithObject:@"CPUExecutionProvider"];
#if __has_include(<onnxruntime/coreml_provider_factory.h>)
        [providers addObject:@"CoreMLExecutionProvider"];
#endif
        resolve(providers);
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Failed to get providers: %@", exception.reason];
        reject(@"PROVIDERS_ERROR", errorMsg, nil);
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
