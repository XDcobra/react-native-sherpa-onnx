#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface SherpaOnnxAudioConvert : NSObject

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

/**
 * Encode raw float32 PCM samples to an output file in the requested format.
 * Bypasses FFmpeg input demuxer/decoder — samples go directly through resampler → encoder → muxer.
 */
+ (BOOL)convertPcmToFormat:(const float *)samples
                numSamples:(int)numSamples
                sampleRate:(int)sampleRate
              channelCount:(int)channelCount
                outputPath:(NSString *)outputPath
                    format:(NSString *)format
        outputSampleRateHz:(int)outputSampleRateHz
                     error:(NSError **)error;

@end

NS_ASSUME_NONNULL_END
