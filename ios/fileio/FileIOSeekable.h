#pragma once

#import "FileIOResolver.h"

#include "fileio/SeekableSource.h"

/** document/ and pdf/: seekable filesystem path into the shared C++ source. */
inline sherpa_onnx::fileio::SeekableSource SherpaOnnxSeekableSourceFromHandle(
    FileIOReadHandle *handle,
    NSString *openFailedCode,
    NSString *logTag,
    NSString **errCode,
    NSString **errMsg) {
  NSString *path =
      [FileIOResolver seekableFilePathFromHandle:handle
                                  openFailedCode:openFailedCode
                                          logTag:logTag
                                           error:errCode
                                         message:errMsg];
  if (!path) {
    return {};
  }
  return sherpa_onnx::fileio::MakeSeekableSource([path UTF8String], -1);
}
