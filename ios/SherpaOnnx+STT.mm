#import "SherpaOnnx.h"
#import <React/RCTLog.h>

#include "sherpa-onnx-stt-wrapper.h"
#include <memory>
#include <optional>
#include <string>

// Global STT wrapper instance
static std::unique_ptr<sherpaonnx::SttWrapper> g_stt_wrapper = nullptr;

@implementation SherpaOnnx (STT)

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

- (void)transcribeFile:(NSString *)filePath
          withResolver:(RCTPromiseResolveBlock)resolve
          withRejecter:(RCTPromiseRejectBlock)reject
{
    if (g_stt_wrapper == nullptr || !g_stt_wrapper->isInitialized()) {
        NSString *errorMsg = @"STT not initialized. Call initialize() first.";
        RCTLogError(@"Transcribe error: %@", errorMsg);
        reject(@"TRANSCRIBE_ERROR", errorMsg, nil);
        return;
    }

    try {
        std::string filePathStr = [filePath UTF8String];
        std::string result = g_stt_wrapper->transcribeFile(filePathStr);

        NSString *transcribedText = [NSString stringWithUTF8String:result.c_str()];
        if (transcribedText == nil) {
            transcribedText = @"";
        }
        resolve(transcribedText);
    } catch (const std::exception& e) {
        NSString *errorMsg = e.what() ? [NSString stringWithUTF8String:e.what()] : @"Recognition failed.";
        if (!errorMsg) errorMsg = @"Recognition failed.";
        RCTLogError(@"Transcribe error: %@", errorMsg);
        reject(@"TRANSCRIBE_ERROR", errorMsg, nil);
    } catch (...) {
        NSString *errorMsg = @"Unknown error during transcription";
        RCTLogError(@"Transcribe error: %@", errorMsg);
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

@end
