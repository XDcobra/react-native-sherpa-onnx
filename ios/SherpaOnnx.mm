/**
 * SherpaOnnx.mm
 *
 * Purpose: Main React Native TurboModule for SherpaOnnx. Implements resolveModelPath (delegates to
 * ios/assets/bridge), extractArchive/computeFileSha256 via sherpa-onnx-archive-helper, capability
 * stubs (QNN/NNAPI/XNNPACK/CoreML), and event registration. Asset/path logic lives in
 * ios/assets/{bridge,core}; pipeline audio in ios/audio/{bridge,pipeline}; STT in ios/stt/bridge
 * (SherpaOnnx+STT.mm, SherpaOnnx+OnlineSTT.mm); TTS in ios/tts/bridge (SherpaOnnx+TTS*.mm) plus
 * ios/tts/{engine,native,options,subtitle,wav}; file I/O in fileio/ (SherpaOnnx+FileIO.mm).
 */

#import "SherpaOnnx.h"
#import "assets/bridge/SherpaOnnx+Assets.h"
#import "fileio/FileIOResolver.h"
#import "sherpa-onnx-archive-helper.h"
#import <React/RCTLog.h>
#import <AVFoundation/AVFoundation.h>
#import "audio/session/PaAudioSessionCoordinator.h"
#include "pcm/PcmPlayerRegistry.h"
#include "audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "textbuffer/core/SherpaOnnx+TextBufferGlobals.h"
#include "segmentbuffer/core/SherpaOnnx+SegmentBufferGlobals.h"
#if __has_include("SherpaOnnx-Swift.h")
#import "SherpaOnnx-Swift.h"
#endif

// Defined in SherpaOnnx+PipelineAudioMic.mm
extern void paMicStopQueue(void);
// ios/punctuation/bridge/SherpaOnnx+OfflinePunctuation.mm
extern "C" void sherpaonnx_punct_offline_invalidate_all(void);
extern "C" void sherpaonnx_punct_online_invalidate_all(void);
// ios/segment/bridge/SherpaOnnx+SegmentLinkMap.mm
extern "C" void slm_release_all_link_maps(void);

@interface SherpaOnnx (JSI)
- (BOOL)autoInstallJSI;
@end

@implementation SherpaOnnx

+ (NSString *)moduleName
{
    return @"SherpaOnnx";
}

- (instancetype)init
{
    self = [super initWithDisabledObservation];
    if (self) {
        [self autoInstallJSI];
        // Sweep orphaned mmap temp files from previous sessions
        pa_sweepOrphanedTempFiles();
        // Sweep orphaned orchestration temp files from previous sessions
        pa_cleanupOrphanedOrchestrationFiles();
    }
    return self;
}

- (void)invalidate
{
    paMicStopQueue();
    sherpaonnx_punct_offline_invalidate_all();
    sherpaonnx_punct_online_invalidate_all();
    txt_release_all_entries();
    seg_release_all_entries();
    slm_release_all_link_maps();
    pcmPlayerDestroyAll();
    [[PaAudioSessionCoordinator shared] resetAll];
    [super invalidate];
}

- (void)setBridge:(RCTBridge *)bridge
{
    [super setBridge:bridge];
    [self autoInstallJSI];
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
    return std::make_shared<facebook::react::NativeSherpaOnnxSpecJSI>(params);
}

- (NSArray<NSString *> *)supportedEvents
{
    return @[ @"extractArchiveProgress", @"pipelineLiveAudioChunk", @"pipelineLiveAudioError", @"pipelineLiveTextPartial", @"pipelineLiveTextError", @"pipelineLiveTextSegment", @"pipelineLiveSegmentAppended", @"pipelineLiveSegmentError", @"fileIOProgress", @"decodeProgress", @"decodeComplete", @"streamingPipelineCompleted", @"pcmPlayerEnded", @"vadEvent" ];
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

- (void)getDeviceQnnSoc:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
    resolve(@{ @"soc": [NSNull null], @"isSupported": @NO });
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

- (void)extractArchive:(NSString *)sourcePath
            targetPath:(NSString *)targetPath
                 force:(BOOL)force
           skipEntries:(double)skipEntries
           operationId:(NSString *)operationId
showNotificationsEnabled:(NSNumber *)showNotificationsEnabled
     notificationTitle:(NSString *)notificationTitle
      notificationText:(NSString *)notificationText
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
    (void)showNotificationsEnabled;
    (void)notificationTitle;
    (void)notificationText;
    SherpaOnnxArchiveHelper *helper = [SherpaOnnxArchiveHelper new];
    NSDictionary *result = [helper extract:sourcePath
                                targetPath:targetPath
                                     force:force
                               skipEntries:(int)skipEntries
                               operationId:operationId
                                  progress:^(long long bytes, long long totalBytes, double percent, int entryIndex) {
        [self sendEventWithName:@"extractArchiveProgress"
                           body:@{ @"sourcePath": sourcePath,
                                   @"operationId": operationId ?: @"",
                                   @"bytes": @(bytes),
                                   @"totalBytes": @(totalBytes),
                                   @"percent": @(percent),
                                   @"entryIndex": @(entryIndex) }];
    }];
    resolve(result);
}

- (void)extractArchiveFromAsset:(NSString *)assetPath
                     targetPath:(NSString *)targetPath
                          force:(BOOL)force
                    skipEntries:(double)skipEntries
                    operationId:(NSString *)operationId
       showNotificationsEnabled:(NSNumber *)showNotificationsEnabled
              notificationTitle:(NSString *)notificationTitle
               notificationText:(NSString *)notificationText
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject
{
    (void)force;
    (void)skipEntries;
    (void)operationId;
    (void)showNotificationsEnabled;
    (void)notificationTitle;
    (void)notificationText;
    resolve(@{
        @"success": @NO,
        @"paused": @NO,
        @"lastEntryIndex": @(-1),
        @"lastEntryPath": @"",
        @"bytesExtracted": @(0),
        @"reason": @"Not supported on iOS; use path-based extraction.",
    });
}

- (void)cancelExtraction:(NSString *)operationId
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
    [SherpaOnnxArchiveHelper cancelOperation:operationId];
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

- (void)getAssetPackPath:(NSString *)packName
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
    // Play Asset Delivery is Android-only; on iOS there is no asset pack path.
    resolve([NSNull null]);
}

- (void)listBundledArchiveAssetPaths:(NSString *)packName
                             resolve:(RCTPromiseResolveBlock)resolve
                              reject:(RCTPromiseRejectBlock)reject
{
    // PAD APK_ASSETS listing is Android-only.
    resolve(@[]);
}

// ─── FileSource helpers ──────────────────────────────────────────────

- (void)resolveAppBaseDir:(NSString *)base
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
    NSString *dirPath = nil;
    if ([base isEqualToString:@"cache"]) {
        dirPath = [NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES) firstObject];
    } else if ([base isEqualToString:@"documents"]) {
        dirPath = [NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES) firstObject];
    } else if ([base isEqualToString:@"files"]) {
        dirPath = [NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES) firstObject];
    } else if ([base isEqualToString:@"tmp"]) {
        dirPath = NSTemporaryDirectory();
    } else if ([base isEqualToString:@"externalFiles"]) {
        reject(kFIOErrUnsupportedOnPlatform, @"externalFiles is not supported on iOS", nil);
        return;
    } else {
        reject(kFIOErrUnsupportedLocationKind,
               [NSString stringWithFormat:@"Unknown AppBaseDir: %@", base], nil);
        return;
    }
    if (!dirPath) {
        reject(kFIOErrResolveError, @"Could not resolve directory", nil);
        return;
    }

    // Ensure the directory exists and reject if creation fails.
    NSFileManager *fm = [NSFileManager defaultManager];
    BOOL isDirectory = NO;
    BOOL exists = [fm fileExistsAtPath:dirPath isDirectory:&isDirectory];
    if (exists && !isDirectory) {
        reject(kFIOErrResolveError,
               [NSString stringWithFormat:@"Resolved app base path is not a directory: %@", dirPath],
               nil);
        return;
    }
    if (!exists) {
        NSError *createError = nil;
        BOOL created = [fm createDirectoryAtPath:dirPath
                     withIntermediateDirectories:YES
                                      attributes:nil
                                           error:&createError];
        if (!created) {
            reject(kFIOErrWriteError,
                   [NSString stringWithFormat:@"Failed to create app base directory: %@", dirPath],
                   createError);
            return;
        }
    }

    resolve(dirPath);
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

- (void)readAssetFileAsUtf8:(NSString *)assetPath
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
    // Validate assetPath to prevent path traversal: reject any path that
    // contains "..", is absolute, or uses backslashes.
    if ([assetPath containsString:@".."] ||
        [assetPath hasPrefix:@"/"] ||
        [assetPath hasPrefix:@"\\"] ||
        [assetPath containsString:@"\\"]) {
        reject(@"ASSET_READ_ERROR",
               [NSString stringWithFormat:@"Invalid asset path: %@", assetPath],
               nil);
        return;
    }
    NSString *fullPath = nil;
    NSBundle *mainBundle = [NSBundle mainBundle];
    NSString *assetDir = [assetPath stringByDeletingLastPathComponent];
    NSString *assetNameWithExt = [assetPath lastPathComponent];
    NSString *assetName = [assetNameWithExt stringByDeletingPathExtension];
    NSString *assetExt = [assetNameWithExt pathExtension];

    // 1) App bundle: regular nested path (keeps generic asset support)
    NSString *mainPath = [mainBundle pathForResource:assetName
                                              ofType:assetExt.length > 0 ? assetExt : nil
                                         inDirectory:assetDir.length > 0 ? assetDir : nil];
    if (mainPath.length > 0) {
        fullPath = mainPath;
    }

    // 2) CocoaPods resource bundle: files are flattened into bundle root
    if (!fullPath) {
        NSString *resBundlePath = [mainBundle pathForResource:@"SherpaOnnxResources"
                                                       ofType:@"bundle"];
        if (resBundlePath.length > 0) {
            NSBundle *resBundle = [NSBundle bundleWithPath:resBundlePath];
            if (resBundle) {
                NSString *bundleRootPath = [resBundle pathForResource:assetName
                                                                ofType:assetExt.length > 0 ? assetExt : nil];
                if (bundleRootPath.length > 0) {
                    fullPath = bundleRootPath;
                }
            }
        }
    }

    if (!fullPath) {
        reject(@"ASSET_READ_ERROR",
               [NSString stringWithFormat:@"Failed to locate asset %@", assetPath],
               nil);
        return;
    }

    NSError *error = nil;
    NSString *content = [NSString stringWithContentsOfFile:fullPath
                                                   encoding:NSUTF8StringEncoding
                                                      error:&error];
    if (error || content == nil) {
        reject(@"ASSET_READ_ERROR",
               [NSString stringWithFormat:@"Failed to read asset %@ at %@: %@",
                assetPath,
                fullPath,
                error.localizedDescription ?: @"Unknown error"],
               error);
        return;
    }

    resolve(content);
}

@end
