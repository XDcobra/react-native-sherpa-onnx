/**
 * SherpaOnnx+TTSExport.mm — Save TTS audio to file (WAV / FFmpeg).
 */

#import "SherpaOnnx.h"
#import "SherpaOnnxAudioConvert.h"
#import <React/RCTLog.h>

#include "native/sherpa-onnx-tts-wrapper.h"

#include <cmath>
#include <string>
#include <vector>

@implementation SherpaOnnx (TTSExport)

- (void)so_saveTtsAudio:(NSArray<NSNumber *> *)samples
          sampleRate:(double)sampleRate
   destinationType:(NSString *)destinationType
pathOrDirectoryUri:(NSString *)pathOrDirectoryUri
          filename:(NSString *)filename
            format:(NSString *)format
outputSampleRateHz:(double)outputSampleRateHz
            resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject
{
    (void)filename;
    @try {
        NSString *fmt = format.length > 0 ? [format lowercaseString] : @"wav";
        if ([destinationType isEqualToString:@"androidContent"]) {
            reject(@"TTS_SAVE_ERROR", @"destinationType androidContent is only supported on Android", nil);
            return;
        }
        if (![destinationType isEqualToString:@"file"]) {
            reject(@"TTS_SAVE_ERROR", @"Invalid destinationType (iOS: use file)", nil);
            return;
        }

        std::vector<float> samplesVec;
        samplesVec.reserve([samples count]);
        for (NSNumber *num in samples) {
            samplesVec.push_back([num floatValue]);
        }

        NSString *outPath = pathOrDirectoryUri;
        if ([outPath hasPrefix:@"file://"]) {
            outPath = [[NSURL URLWithString:outPath] path];
        }

        if ([fmt isEqualToString:@"wav"] || [fmt isEqualToString:@"wav16k"]) {
            std::string filePathStr = std::string([outPath UTF8String]);
            bool success = sherpaonnx::TtsWrapper::saveToWavFile(
                samplesVec,
                static_cast<int32_t>(sampleRate),
                filePathStr
            );
            if (success) {
                resolve(outPath);
            } else {
                reject(@"TTS_SAVE_ERROR", @"Failed to save audio to file", nil);
            }
            return;
        }

#if HAVE_FFMPEG
        NSString *tmpWav = [NSTemporaryDirectory() stringByAppendingPathComponent:
            [NSString stringWithFormat:@"sherpa_tts_encode_%lld.wav", (long long)([[NSDate date] timeIntervalSince1970] * 1000000)]];
        std::string tmpStr = std::string([tmpWav UTF8String]);
        if (!sherpaonnx::TtsWrapper::saveToWavFile(samplesVec, static_cast<int32_t>(sampleRate), tmpStr)) {
            reject(@"TTS_SAVE_ERROR", @"Failed to write temporary WAV for encoding", nil);
            return;
        }
        NSError *convErr = nil;
        int outHz = (int)lround(outputSampleRateHz);
        BOOL ok = [SherpaOnnxAudioConvert convertAudioToFormat:tmpWav
                                                     outputPath:outPath
                                                         format:fmt
                                             outputSampleRateHz:outHz
                                                          error:&convErr];
        [[NSFileManager defaultManager] removeItemAtPath:tmpWav error:nil];
        if (ok) {
            resolve(outPath);
        } else {
            NSString *msg = convErr.localizedDescription ?: @"Audio conversion failed";
            reject(@"TTS_SAVE_ERROR", msg, convErr);
        }
#else
        reject(@"TTS_SAVE_ERROR", @"Non-WAV TTS export requires FFmpeg (HAVE_FFMPEG). Use format wav or enable FFmpeg in the pod build.", nil);
#endif
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception saving TTS audio: %@", exception.reason];
        reject(@"TTS_SAVE_ERROR", errorMsg, nil);
    }
}

@end
