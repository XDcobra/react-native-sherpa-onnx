#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface SherpaOnnxAudioConvert : NSObject

/**
 * Converts any supported audio file to 16 kHz mono 16-bit PCM WAV.
 * Returns YES on success, NO on failure. Populates `error` on failure.
 */
+ (BOOL)convertAudioToWav16k:(NSString *)inputPath
                  outputPath:(NSString *)outputPath
                       error:(NSError **)error;

/**
 * Converts arbitrary audio file to requested format (e.g. "mp3", "flac", "wav").
 * outputSampleRateHz is mostly used for MP3 encoding.
 * Returns YES on success, NO on failure. Populates `error` on failure.
 */
+ (BOOL)convertAudioToFormat:(NSString *)inputPath
                  outputPath:(NSString *)outputPath
                      format:(NSString *)format
          outputSampleRateHz:(int)outputSampleRateHz
                       error:(NSError **)error;

@end

NS_ASSUME_NONNULL_END
