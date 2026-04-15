#pragma once

#ifdef __OBJC__
#import <Foundation/Foundation.h>
#else
typedef struct NSString NSString;
typedef struct NSFileManager NSFileManager;
typedef struct NSMutableSet NSMutableSet;
#endif

#ifdef __cplusplus
extern "C" {
#endif

#ifdef __OBJC__
void SherpaOnnxCollectModelFolderNames(NSFileManager *fileManager,
                                       NSString *path,
                                       NSMutableSet<NSString *> *outNames);
#else
void SherpaOnnxCollectModelFolderNames(NSFileManager *fileManager,
                                       NSString *path,
                                       NSMutableSet *outNames);
#endif

NSString *SherpaOnnxInferModelHint(NSString *folderName);

#ifdef __cplusplus
}
#endif
