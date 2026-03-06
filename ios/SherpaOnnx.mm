/**
 * SherpaOnnx.mm
 *
 * Purpose: Main React Native TurboModule for SherpaOnnx. Implements resolveModelPath (delegates to
 * SherpaOnnx+Assets.mm), extractTarBz2/computeFileSha256 via sherpa-onnx-archive-helper, capability
 * stubs (QNN/NNAPI/XNNPACK/CoreML), and event registration. Asset/path logic lives in
 * SherpaOnnx+Assets.mm; STT/TTS in SherpaOnnx+STT.mm and SherpaOnnx+TTS.mm.
 */

#import "SherpaOnnx.h"
#import "SherpaOnnx+Assets.h"
#import "sherpa-onnx-archive-helper.h"
#import <React/RCTLog.h>
#import <AVFoundation/AVFoundation.h>
#if __has_include("SherpaOnnx-Swift.h")
#import "SherpaOnnx-Swift.h"
#endif

@implementation SherpaOnnx

+ (NSString *)moduleName
{
    return @"SherpaOnnx";
}

- (instancetype)init
{
    self = [super initWithDisabledObservation];
    return self;
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
    return std::make_shared<facebook::react::NativeSherpaOnnxSpecJSI>(params);
}

- (NSArray<NSString *> *)supportedEvents
{
    return @[ @"ttsStreamChunk", @"ttsStreamEnd", @"ttsStreamError", @"extractTarBz2Progress", @"pcmLiveStreamData", @"pcmLiveStreamError" ];
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

- (void)getAssetPackPath:(NSString *)packName
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
    // Play Asset Delivery is Android-only; on iOS there is no asset pack path.
    resolve([NSNull null]);
}

- (BOOL)convertToWav16kMonoWithInputURL:(NSURL *)inputURL
                             outputURL:(NSURL *)outputURL
                                 error:(NSError **)outError
{
    NSError *error = nil;
    AVAudioFile *inputFile = [[AVAudioFile alloc] initForReading:inputURL error:&error];
    if (!inputFile) {
        if (outError) *outError = error;
        return NO;
    }
    AVAudioFormat *outputFormat = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatInt16
                                                                   sampleRate:16000
                                                                     channels:1
                                                              interleaved:YES];
    if (!outputFormat) {
        if (outError) {
            *outError = [NSError errorWithDomain:@"SherpaOnnx" code:-1 userInfo:@{ NSLocalizedDescriptionKey: @"Failed to create output format 16kHz mono Int16" }];
        }
        return NO;
    }
    AVAudioConverter *converter = [[AVAudioConverter alloc] initFromFormat:inputFile.processingFormat toFormat:outputFormat];
    if (!converter) {
        if (outError) {
            *outError = [NSError errorWithDomain:@"SherpaOnnx" code:-1 userInfo:@{ NSLocalizedDescriptionKey: @"AVAudioConverter init failed" }];
        }
        return NO;
    }
    NSDictionary *settings = @{
        AVFormatIDKey: @(kAudioFormatLinearPCM),
        AVSampleRateKey: @16000,
        AVNumberOfChannelsKey: @1,
        AVLinearPCMBitDepthKey: @16,
        AVLinearPCMIsFloatKey: @NO,
        AVLinearPCMIsBigEndianKey: @NO
    };
    AVAudioFile *outputFile = [[AVAudioFile alloc] initForWriting:outputURL settings:settings error:&error];
    if (!outputFile) {
        if (outError) *outError = error;
        return NO;
    }
    const AVAudioFrameCount kInputFramesPerBlock = 4096;
    AVAudioPCMBuffer *inputBuffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:inputFile.processingFormat frameCapacity:kInputFramesPerBlock];
    AVAudioFrameCount outputCapacity = (AVAudioFrameCount)((double)kInputFramesPerBlock * 16000.0 / inputFile.processingFormat.sampleRate) + 32;
    if (outputCapacity < 1024) outputCapacity = 1024;
    AVAudioPCMBuffer *outputBuffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:outputFormat frameCapacity:outputCapacity];
    __block BOOL inputExhausted = NO;
    AVAudioConverterInputBlock inputBlock = ^AVAudioBuffer * _Nullable(AVAudioPacketCount inNumberOfPackets, AVAudioConverterInputStatus *outStatus) {
        if (inputExhausted) {
            *outStatus = AVAudioConverterInputStatusNoDataNow;
            return nil;
        }
        NSError *readErr = nil;
        [inputFile readIntoBuffer:inputBuffer frameCount:kInputFramesPerBlock error:&readErr];
        if (readErr || inputBuffer.frameLength == 0) {
            inputExhausted = YES;
            *outStatus = AVAudioConverterInputStatusEndOfStream;
            return nil;
        }
        *outStatus = AVAudioConverterInputStatusHaveData;
        return inputBuffer;
    };
    while (YES) {
        AVAudioConverterOutputStatus status = [converter convertToBuffer:outputBuffer error:&error withInputFromBlock:inputBlock];
        if (error) break;
        if (status == AVAudioConverterOutputStatusError) break;
        if (outputBuffer.frameLength == 0) break;
        [outputFile writeFromBuffer:outputBuffer error:&error];
        if (error) break;
    }
    if (error && error.code != 0) {
        if (outError) *outError = error;
        return NO;
    }
    return YES;
}

- (void)convertAudioToFormat:(NSString *)inputPath
                 outputPath:(NSString *)outputPath
                     format:(NSString *)format
         outputSampleRateHz:(NSNumber *)outputSampleRateHz
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
    NSString *fmt = [format lowercaseString];
    if (![fmt isEqualToString:@"wav"]) {
        reject(@"UNSUPPORTED", @"MP3/FLAC encoding not available on iOS; use WAV output or convert server-side", nil);
        return;
    }
    NSURL *inputURL = [NSURL fileURLWithPath:inputPath];
    NSURL *outputURL = [NSURL fileURLWithPath:outputPath];
    NSError *error = nil;
    if (![self convertToWav16kMonoWithInputURL:inputURL outputURL:outputURL error:&error]) {
        reject(@"CONVERT_ERROR", error ? error.localizedDescription : @"Conversion failed", error);
        return;
    }
    resolve(nil);
}

- (void)convertAudioToWav16k:(NSString *)inputPath
                 outputPath:(NSString *)outputPath
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
    NSURL *inputURL = [NSURL fileURLWithPath:inputPath];
    NSURL *outputURL = [NSURL fileURLWithPath:outputPath];
    NSError *error = nil;
    if (![self convertToWav16kMonoWithInputURL:inputURL outputURL:outputURL error:&error]) {
        reject(@"CONVERT_ERROR", error ? error.localizedDescription : @"Conversion to WAV 16kHz mono failed", error);
        return;
    }
    resolve(nil);
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

@end
