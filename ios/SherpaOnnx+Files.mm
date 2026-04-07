/**
 * SherpaOnnx+Files.mm
 *
 * File persistence and sharing (paths, cache copy, share sheet). Not TTS-engine-specific.
 */

#import "SherpaOnnx.h"
#import <React/RCTLog.h>
#import <React/RCTUtils.h>
#import <UIKit/UIKit.h>

@implementation SherpaOnnx (Files)

- (void)copyContentUriToCache:(NSString *)fileUri
                     filename:(NSString *)filename
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
    @try {
        if ([fileUri hasPrefix:@"content://"]) {
            reject(@"TTS_SAVE_ERROR", @"Content URIs are not supported on iOS", nil);
            return;
        }
        NSString *srcPath = [fileUri hasPrefix:@"file://"]
            ? [[NSURL URLWithString:fileUri] path]
            : fileUri;
        NSFileManager *fm = [NSFileManager defaultManager];
        if (![fm fileExistsAtPath:srcPath]) {
            reject(@"TTS_SAVE_ERROR", @"Source file does not exist", nil);
            return;
        }
        NSArray *caches = NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES);
        NSString *cacheDir = caches.firstObject;
        NSString *destPath = [[cacheDir stringByAppendingPathComponent:@"sherpa_tts"] stringByAppendingPathComponent:filename];
        NSError *err = nil;
        [fm createDirectoryAtPath:[destPath stringByDeletingLastPathComponent] withIntermediateDirectories:YES attributes:nil error:&err];
        if (err) {
            reject(@"TTS_SAVE_ERROR", err.localizedDescription, err);
            return;
        }
        if ([fm fileExistsAtPath:destPath]) {
            [fm removeItemAtPath:destPath error:nil];
        }
        BOOL ok = [fm copyItemAtPath:srcPath toPath:destPath error:&err];
        if (!ok || err) {
            reject(@"TTS_SAVE_ERROR", err ? err.localizedDescription : @"Copy failed", err);
            return;
        }
        resolve(destPath);
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception copying file: %@", exception.reason];
        reject(@"TTS_SAVE_ERROR", errorMsg, nil);
    }
}

- (void)copyFileToContentUri:(NSString *)filePath
              directoryUri:(NSString *)directoryUri
                  filename:(NSString *)filename
                  mimeType:(NSString *)mimeType
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
    reject(@"TTS_SAVE_ERROR", @"Copy file to content URI is not supported on iOS (Android SAF only)", nil);
}

- (void)saveTextToContentUri:(NSString *)text
                directoryUri:(NSString *)directoryUri
                    filename:(NSString *)filename
                    mimeType:(NSString *)mimeType
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject
{
    @try {
        if ([directoryUri hasPrefix:@"content://"]) {
            reject(@"TTS_SAVE_ERROR", @"Content URIs are not supported on iOS", nil);
            return;
        }

        NSURL *directoryUrl = nil;
        if ([directoryUri hasPrefix:@"file://"]) {
            directoryUrl = [NSURL URLWithString:directoryUri];
        } else {
            directoryUrl = [NSURL fileURLWithPath:directoryUri];
        }

        if (!directoryUrl) {
            reject(@"TTS_SAVE_ERROR", @"Invalid directory URL", nil);
            return;
        }

        NSString *directoryPath = [directoryUrl path];
        NSString *outPath = [directoryPath stringByAppendingPathComponent:filename];

        NSError *writeError = nil;
        BOOL success = [text writeToFile:outPath
                               atomically:YES
                                 encoding:NSUTF8StringEncoding
                                    error:&writeError];

        if (!success || writeError) {
            reject(@"TTS_SAVE_ERROR", @"Failed to save text to file", writeError);
            return;
        }

        resolve(outPath);
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Exception saving text file: %@", exception.reason];
        reject(@"TTS_SAVE_ERROR", errorMsg, nil);
    }
}

- (void)shareAudioFile:(NSString *)fileUri
              mimeType:(NSString *)mimeType
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
    @try {
        NSURL *url = nil;
        if ([fileUri hasPrefix:@"file://"] || [fileUri hasPrefix:@"content://"]) {
            url = [NSURL URLWithString:fileUri];
        } else {
            url = [NSURL fileURLWithPath:fileUri];
        }

        if (!url) {
            reject(@"TTS_SHARE_ERROR", @"Invalid file URL", nil);
            return;
        }

        dispatch_async(dispatch_get_main_queue(), ^{
            UIViewController *controller = RCTPresentedViewController();
            if (!controller) {
                reject(@"TTS_SHARE_ERROR", @"No active view controller", nil);
                return;
            }

            UIActivityViewController *activity =
                [[UIActivityViewController alloc] initWithActivityItems:@[url]
                                                  applicationActivities:nil];
            [controller presentViewController:activity animated:YES completion:nil];
            resolve(nil);
        });
    } @catch (NSException *exception) {
        NSString *errorMsg = [NSString stringWithFormat:@"Failed to share audio: %@", exception.reason];
        reject(@"TTS_SHARE_ERROR", errorMsg, nil);
    }
}

@end
