#import "SherpaOnnx.h"

@interface SherpaOnnx (TTSOfflineInternal)
- (void)so_updateTtsParams:(NSString *)instanceId
                noiseScale:(NSNumber *)noiseScale
               noiseScaleW:(NSNumber *)noiseScaleW
               lengthScale:(NSNumber *)lengthScale
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject;
- (void)so_generateTts:(NSString *)instanceId
                  text:(NSString *)text
               options:(NSDictionary *)options
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject;
- (void)so_generateTtsWithTimestamps:(NSString *)instanceId
                                text:(NSString *)text
                             options:(NSDictionary *)options
                             resolve:(RCTPromiseResolveBlock)resolve
                              reject:(RCTPromiseRejectBlock)reject;
- (void)so_getTtsSamples:(NSString *)instanceId
              generation:(double)generation
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject;
- (void)so_saveTtsAudioFromSink:(NSString *)instanceId
                     generation:(double)generation
                destinationType:(NSString *)destinationType
             pathOrDirectoryUri:(NSString *)pathOrDirectoryUri
                       filename:(NSString *)filename
                         format:(NSString *)format
             outputSampleRateHz:(double)outputSampleRateHz
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject;
- (void)so_saveTtsAudioFromPCM:(NSArray<NSNumber *> *)samples
              sampleRate:(double)sampleRate
           destinationType:(NSString *)destinationType
      pathOrDirectoryUri:(NSString *)pathOrDirectoryUri
                filename:(NSString *)filename
                  format:(NSString *)format
      outputSampleRateHz:(double)outputSampleRateHz
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject;
- (void)so_playTtsFromSink:(NSString *)instanceId
                generation:(double)generation
                sampleRate:(double)sampleRate
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject;
@end

@implementation SherpaOnnx (TTSOffline)

- (void)updateTtsParams:(NSString *)instanceId
             noiseScale:(NSNumber *)noiseScale
            noiseScaleW:(NSNumber *)noiseScaleW
            lengthScale:(NSNumber *)lengthScale
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject {
  [self so_updateTtsParams:instanceId
                noiseScale:noiseScale
               noiseScaleW:noiseScaleW
               lengthScale:lengthScale
                   resolve:resolve
                    reject:reject];
}

- (void)generateTts:(NSString *)instanceId
               text:(NSString *)text
            options:(NSDictionary *)options
            resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject {
  [self so_generateTts:instanceId text:text options:options resolve:resolve reject:reject];
}

- (void)generateTtsWithTimestamps:(NSString *)instanceId
                             text:(NSString *)text
                          options:(NSDictionary *)options
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject {
  [self so_generateTtsWithTimestamps:instanceId
                                text:text
                             options:options
                             resolve:resolve
                              reject:reject];
}

- (void)saveTtsAudioFromPCM:(NSArray<NSNumber *> *)samples
          sampleRate:(double)sampleRate
     destinationType:(NSString *)destinationType
 pathOrDirectoryUri:(NSString *)pathOrDirectoryUri
            filename:(NSString *)filename
              format:(NSString *)format
  outputSampleRateHz:(double)outputSampleRateHz
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject {
  [self so_saveTtsAudioFromPCM:samples
             sampleRate:sampleRate
        destinationType:destinationType
    pathOrDirectoryUri:pathOrDirectoryUri
               filename:filename
                 format:format
     outputSampleRateHz:outputSampleRateHz
                 resolve:resolve
                  reject:reject];
}

- (void)getTtsSamples:(NSString *)instanceId
           generation:(double)generation
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject {
  [self so_getTtsSamples:instanceId generation:generation resolve:resolve reject:reject];
}

- (void)saveTtsAudioFromSink:(NSString *)instanceId
                  generation:(double)generation
             destinationType:(NSString *)destinationType
          pathOrDirectoryUri:(NSString *)pathOrDirectoryUri
                    filename:(NSString *)filename
                      format:(NSString *)format
          outputSampleRateHz:(double)outputSampleRateHz
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject {
  [self so_saveTtsAudioFromSink:instanceId
                     generation:generation
                destinationType:destinationType
             pathOrDirectoryUri:pathOrDirectoryUri
                       filename:filename
                         format:format
             outputSampleRateHz:outputSampleRateHz
                        resolve:resolve
                         reject:reject];
}

- (void)playTtsFromSink:(NSString *)instanceId
             generation:(double)generation
             sampleRate:(double)sampleRate
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject {
  [self so_playTtsFromSink:instanceId generation:generation sampleRate:sampleRate resolve:resolve reject:reject];
}

@end
