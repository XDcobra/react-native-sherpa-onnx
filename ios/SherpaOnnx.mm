#import "SherpaOnnx.h"
#import <React/RCTUtils.h>
#import <React/RCTLog.h>
#import "sherpa-onnx-wrapper.h"
#import <memory>
#import <optional>
#import <string>

@implementation SherpaOnnx
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

// Global wrapper instance
static std::unique_ptr<sherpaonnx::SttWrapper> g_stt_wrapper = nullptr;

// Global TTS wrapper instance
static std::unique_ptr<sherpaonnx::TtsWrapper> g_tts_wrapper = nullptr;

- (void)initializeSherpaOnnx:(NSString *)modelDir
                preferInt8:(NSNumber *)preferInt8
                 modelType:(NSString *)modelType
                withResolver:(RCTPromiseResolveBlock)resolve
                withRejecter:(RCTPromiseRejectBlock)reject
{
    RCTLogInfo(@"Initializing sherpa-onnx with modelDir: %@", modelDir);
    
    @try {
        if (g_stt_wrapper == nullptr) {
            g_stt_wrapper = std::make_unique<sherpaonnx::SttWrapper>();
        }
        
        std::string modelDirStr = [modelDir UTF8String];
        
        // Convert NSNumber to std::optional<bool>
        std::optional<bool> preferInt8Opt = std::nullopt;
        if (preferInt8 != nil) {
            preferInt8Opt = [preferInt8 boolValue];
        }
        
        // Convert NSString to std::optional<std::string>
        std::optional<std::string> modelTypeOpt = std::nullopt;
        if (modelType != nil && [modelType length] > 0) {
            modelTypeOpt = [modelType UTF8String];
        }
        
        sherpaonnx::SttInitializeResult result = g_stt_wrapper->initialize(modelDirStr, preferInt8Opt, modelTypeOpt);
        
        if (result.success) {
            RCTLogInfo(@"Sherpa-onnx initialized successfully");
            
            // Create result dictionary with detected models
            NSMutableDictionary *resultDict = [NSMutableDictionary dictionary];
            resultDict[@"success"] = @YES;
            
            NSMutableArray *detectedModelsArray = [NSMutableArray array];
            for (const auto& model : result.detectedModels) {
                NSMutableDictionary *modelDict = [NSMutableDictionary dictionary];
                modelDict[@"type"] = [NSString stringWithUTF8String:model.type.c_str()];
                modelDict[@"modelDir"] = [NSString stringWithUTF8String:model.modelDir.c_str()];
                [detectedModelsArray addObject:modelDict];
            }
            resultDict[@"detectedModels"] = detectedModelsArray;
            
            resolve(resultDict);
        } else {
            NSString *errorMsg = [NSString stringWithFormat:@"Failed to initialize sherpa-onnx with model directory: %@", modelDir];
            RCTLogError(@"%@", errorMsg);
            reject(@"INIT_ERROR", errorMsg, nil);
        }
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception during initialization: %@", exception.reason];
        RCTLogError(@"%@", errorMsg);
        reject(@"INIT_ERROR", errorMsg, nil);
    }
}

- (void)testSherpaInitWithResolver:(RCTPromiseResolveBlock)resolve
                    withRejecter:(RCTPromiseRejectBlock)reject
{
    @try {
        // Test that sherpa-onnx headers are available
        resolve(@"Sherpa ONNX loaded!");
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception during test: %@", exception.reason];
        reject(@"TEST_ERROR", errorMsg, nil);
    }
}

- (void)transcribeFile:(NSString *)filePath
          withResolver:(RCTPromiseResolveBlock)resolve
          withRejecter:(RCTPromiseRejectBlock)reject
{
    @try {
        if (g_stt_wrapper == nullptr || !g_stt_wrapper->isInitialized()) {
            reject(@"TRANSCRIBE_ERROR", @"Sherpa-onnx not initialized. Call initializeSherpaOnnx first.", nil);
            return;
        }
        
        std::string filePathStr = [filePath UTF8String];
        std::string result = g_stt_wrapper->transcribeFile(filePathStr);
        
        // Convert result to NSString - empty strings are valid (e.g., silence)
        NSString *transcribedText = [NSString stringWithUTF8String:result.c_str()];
        if (transcribedText == nil) {
            // If conversion fails, treat as empty string
            transcribedText = @"";
        }
        
        resolve(transcribedText);
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception during transcription: %@", exception.reason];
        RCTLogError(@"%@", errorMsg);
        reject(@"TRANSCRIBE_ERROR", errorMsg, nil);
    }
}

- (void)unloadSherpaOnnxWithResolver:(RCTPromiseResolveBlock)resolve
                      withRejecter:(RCTPromiseRejectBlock)reject
{
    @try {
        if (g_stt_wrapper != nullptr) {
            g_stt_wrapper->release();
            g_stt_wrapper.reset();
            g_stt_wrapper = nullptr;
        }
        RCTLogInfo(@"Sherpa-onnx resources released");
        resolve(nil);
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception during cleanup: %@", exception.reason];
        RCTLogError(@"%@", errorMsg);
        reject(@"CLEANUP_ERROR", errorMsg, nil);
    }
}

// ==================== TTS Methods ====================

- (void)initializeTts:(NSString *)modelDir
            modelType:(NSString *)modelType
           numThreads:(double)numThreads
                debug:(BOOL)debug
         withResolver:(RCTPromiseResolveBlock)resolve
         withRejecter:(RCTPromiseRejectBlock)reject
{
    RCTLogInfo(@"Initializing TTS with modelDir: %@, modelType: %@", modelDir, modelType);
    
    @try {
        if (g_tts_wrapper == nullptr) {
            g_tts_wrapper = std::make_unique<sherpaonnx::TtsWrapper>();
        }
        
        std::string modelDirStr = [modelDir UTF8String];
        std::string modelTypeStr = [modelType UTF8String];
        
        sherpaonnx::TtsInitializeResult result = g_tts_wrapper->initialize(
            modelDirStr,
            modelTypeStr,
            static_cast<int32_t>(numThreads),
            debug
        );
        
        if (result.success) {
            RCTLogInfo(@"TTS initialization successful");
            
            // Create detected models array
            NSMutableArray *detectedModelsArray = [NSMutableArray array];
            for (const auto& model : result.detectedModels) {
                NSDictionary *modelDict = @{
                    @"type": [NSString stringWithUTF8String:model.type.c_str()],
                    @"modelDir": [NSString stringWithUTF8String:model.modelDir.c_str()]
                };
                [detectedModelsArray addObject:modelDict];
            }
            
            // Create result dictionary
            NSDictionary *resultDict = @{
                @"success": @YES,
                @"detectedModels": detectedModelsArray
            };
            
            resolve(resultDict);
        } else {
            NSString *errorMsg = @"Failed to initialize TTS";
            RCTLogError(@"%@", errorMsg);
            reject(@"TTS_INIT_ERROR", errorMsg, nil);
        }
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception during TTS init: %@", exception.reason];
        RCTLogError(@"%@", errorMsg);
        reject(@"TTS_INIT_ERROR", errorMsg, nil);
    }
}

- (void)generateTts:(NSString *)text
                sid:(double)sid
              speed:(double)speed
       withResolver:(RCTPromiseResolveBlock)resolve
       withRejecter:(RCTPromiseRejectBlock)reject
{
    @try {
        if (g_tts_wrapper == nullptr || !g_tts_wrapper->isInitialized()) {
            NSString *errorMsg = @"TTS not initialized. Call initializeTts() first.";
            RCTLogError(@"%@", errorMsg);
            reject(@"TTS_NOT_INITIALIZED", errorMsg, nil);
            return;
        }
        
        std::string textStr = [text UTF8String];
        
        auto result = g_tts_wrapper->generate(
            textStr,
            static_cast<int32_t>(sid),
            static_cast<float>(speed)
        );
        
        if (result.samples.empty() || result.sampleRate == 0) {
            NSString *errorMsg = @"Failed to generate speech or result is empty";
            RCTLogError(@"%@", errorMsg);
            reject(@"TTS_GENERATE_ERROR", errorMsg, nil);
            return;
        }
        
        // Convert samples to NSArray of NSNumber
        NSMutableArray *samplesArray = [NSMutableArray arrayWithCapacity:result.samples.size()];
        for (float sample : result.samples) {
            [samplesArray addObject:@(sample)];
        }
        
        // Create result dictionary
        NSDictionary *resultDict = @{
            @"samples": samplesArray,
            @"sampleRate": @(result.sampleRate)
        };
        
        RCTLogInfo(@"TTS: Generated %lu samples at %d Hz", 
                   (unsigned long)result.samples.size(), result.sampleRate);
        
        resolve(resultDict);
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception during TTS generation: %@", exception.reason];
        RCTLogError(@"%@", errorMsg);
        reject(@"TTS_GENERATE_ERROR", errorMsg, nil);
    }
}

- (void)getTtsSampleRate:(RCTPromiseResolveBlock)resolve
            withRejecter:(RCTPromiseRejectBlock)reject
{
    @try {
        if (g_tts_wrapper == nullptr || !g_tts_wrapper->isInitialized()) {
            NSString *errorMsg = @"TTS not initialized. Call initializeTts() first.";
            reject(@"TTS_NOT_INITIALIZED", errorMsg, nil);
            return;
        }
        
        int32_t sampleRate = g_tts_wrapper->getSampleRate();
        resolve(@(sampleRate));
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception getting sample rate: %@", exception.reason];
        reject(@"TTS_ERROR", errorMsg, nil);
    }
}

- (void)getTtsNumSpeakers:(RCTPromiseResolveBlock)resolve
             withRejecter:(RCTPromiseRejectBlock)reject
{
    @try {
        if (g_tts_wrapper == nullptr || !g_tts_wrapper->isInitialized()) {
            NSString *errorMsg = @"TTS not initialized. Call initializeTts() first.";
            reject(@"TTS_NOT_INITIALIZED", errorMsg, nil);
            return;
        }
        
        int32_t numSpeakers = g_tts_wrapper->getNumSpeakers();
        resolve(@(numSpeakers));
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception getting num speakers: %@", exception.reason];
        reject(@"TTS_ERROR", errorMsg, nil);
    }
}

- (void)unloadTts:(RCTPromiseResolveBlock)resolve
     withRejecter:(RCTPromiseRejectBlock)reject
{
    @try {
        if (g_tts_wrapper != nullptr) {
            g_tts_wrapper->release();
            g_tts_wrapper.reset();
            g_tts_wrapper = nullptr;
        }
        RCTLogInfo(@"TTS resources released");
        resolve(nil);
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception during TTS cleanup: %@", exception.reason];
        RCTLogError(@"%@", errorMsg);
        reject(@"TTS_CLEANUP_ERROR", errorMsg, nil);
    }
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

    if (isStt && !isTts) {
        return @"stt";
    }
    if (isTts && !isStt) {
        return @"tts";
    }
    return @"unknown";
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
    return std::make_shared<facebook::react::NativeSherpaOnnxSpecJSI>(params);
}

+ (NSString *)moduleName
{
  return @"SherpaOnnx";
}

@end
