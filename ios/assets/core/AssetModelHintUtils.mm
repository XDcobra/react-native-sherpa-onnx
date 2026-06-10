#import "AssetModelHintUtils.h"

void SherpaOnnxCollectModelFolderNames(NSFileManager *fileManager,
                                       NSString *path,
                                       NSMutableSet<NSString *> *outNames) {
  BOOL isDirectory = NO;
  if (![fileManager fileExistsAtPath:path isDirectory:&isDirectory] || !isDirectory) {
    return;
  }

  NSError *err = nil;
  NSArray<NSString *> *items = [fileManager contentsOfDirectoryAtPath:path error:&err];
  if (err) {
    return;
  }

  for (NSString *item in items) {
    if ([item hasPrefix:@"."]) {
      continue;
    }
    NSString *itemPath = [path stringByAppendingPathComponent:item];
    BOOL itemIsDir = NO;
    [fileManager fileExistsAtPath:itemPath isDirectory:&itemIsDir];
    if (itemIsDir) {
      [outNames addObject:item];
    }
  }
}

NSString *SherpaOnnxInferModelHint(NSString *folderName) {
  NSString *name = [folderName lowercaseString];
  if ([name containsString:@"wav2vec2"]) {
    return @"alignment";
  }

  // VAD bundles (Sherpa / Silero / Tencent-style). Before STT/TTS heuristics.
  NSArray<NSString *> *vadHints = @[
    @"silero_vad",
    @"silero-vad",
    @"silero",
    @"ten-vad",
    @"tenvad",
    @"sherpa_vad",
    @"sherpa-vad",
    @"vad-int8",
    @"vad_float",
    @"voice_activity",
    @"voice-activity",
    @"vad"
  ];
  for (NSString *hint in vadHints) {
    if ([name containsString:hint]) {
      return @"vad";
    }
  }

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
    @"pocket",
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

  if (isStt && isTts) {
    return @"unknown";
  }
  if (isStt) {
    return @"stt";
  }
  if (isTts) {
    return @"tts";
  }

  BOOL isEnhancement = [name containsString:@"gtcrn"] || [name containsString:@"dpdfnet"];
  if (isEnhancement) {
    return @"enhancement";
  }

  return @"unknown";
}
