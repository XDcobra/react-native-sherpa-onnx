#import "../../SherpaOnnx.h"

#ifdef __cplusplus
#include <optional>
#include <string>
#include <vector>

#include "SegmentLinkMapRegistry.h"

static NSString *slmMetaJsonFromObject(id metaObj) {
  if (metaObj == nil || metaObj == [NSNull null]) {
    return nil;
  }
  if (![metaObj isKindOfClass:[NSDictionary class]]) {
    return nil;
  }
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:metaObj options:0 error:&error];
  if (error != nil || data == nil) {
    return nil;
  }
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}

static NSDictionary *slmMetaObjectFromJson(const std::optional<std::string> &metaJson) {
  if (!metaJson.has_value() || metaJson->empty()) {
    return nil;
  }
  NSString *json = [NSString stringWithUTF8String:metaJson->c_str()];
  if (json == nil || json.length == 0) {
    return nil;
  }
  NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
  if (data == nil) {
    return nil;
  }
  NSError *error = nil;
  id object = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
  if (error != nil || ![object isKindOfClass:[NSDictionary class]]) {
    return nil;
  }
  return (NSDictionary *)object;
}

static NSDictionary *slmLinkToDict(const PaSegmentLink &link) {
  NSMutableDictionary *dict = [@{
    @"linkId": [NSString stringWithUTF8String:link.linkId.c_str()] ?: @"",
    @"textSegmentId": [NSString stringWithUTF8String:link.textSegmentId.c_str()] ?: @"",
    @"speechSegmentId": [NSString stringWithUTF8String:link.speechSegmentId.c_str()] ?: @"",
    @"linkType": [NSString stringWithUTF8String:slm_link_type_raw(link.linkType)] ?: @"user_defined",
  } mutableCopy];

  if (link.confidence.has_value()) {
    dict[@"confidence"] = @(link.confidence.value());
  }

  NSDictionary *meta = slmMetaObjectFromJson(link.metaJson);
  if (meta != nil) {
    dict[@"meta"] = meta;
  }

  return dict;
}

static void slmRejectFromError(RCTPromiseRejectBlock reject, const std::string &err) {
  if (err.find("SEGMENT_LINK_MAP_NOT_FOUND") == 0) {
    reject(@"SEGMENT_LINK_MAP_NOT_FOUND", [NSString stringWithUTF8String:err.c_str()], nil);
  } else if (err.find("SEGMENT_LINK_INVALID") == 0) {
    reject(@"SEGMENT_LINK_INVALID", [NSString stringWithUTF8String:err.c_str()], nil);
  } else {
    reject(@"SEGMENT_LINK_INTERNAL_ERROR", [NSString stringWithUTF8String:err.c_str()], nil);
  }
}

#endif

@implementation SherpaOnnx (SegmentLinkMap)

- (void)createSegmentLinkMap:(JS::NativeSherpaOnnx::SpecCreateSegmentLinkMapOptions &)options
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  @try {
    NSString *textBufferId = options.textBufferId();
    NSString *audioBufferId = options.audioBufferId();
    std::string id;
    std::string err;
    if (!slm_create(textBufferId.length > 0 ? textBufferId.UTF8String : "",
                    audioBufferId.length > 0 ? audioBufferId.UTF8String : "", &id, &err)) {
      slmRejectFromError(reject, err);
      return;
    }
    resolve(@{ @"linkMapId": [NSString stringWithUTF8String:id.c_str()] ?: @"" });
  } @catch (NSException *exception) {
    reject(@"SEGMENT_LINK_INTERNAL_ERROR", exception.reason, nil);
  }
#else
  reject(@"SEGMENT_LINK_INTERNAL_ERROR", @"SegmentLinkMap unavailable", nil);
#endif
}

- (void)addSegmentLink:(NSString *)linkMapId
                  link:(JS::NativeSherpaOnnx::SpecAddSegmentLinkLink &)link
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  @try {
    std::string mapId = linkMapId.UTF8String ?: "";
    NSString *textSegmentIdRaw = link.textSegmentId();
    NSString *speechSegmentIdRaw = link.speechSegmentId();
    std::string textSegmentId =
      textSegmentIdRaw != nil ? std::string([textSegmentIdRaw UTF8String] ?: "") : std::string();
    std::string speechSegmentId =
      speechSegmentIdRaw != nil ? std::string([speechSegmentIdRaw UTF8String] ?: "") : std::string();

    bool hasConfidence = false;
    float confidence = 0.f;
    auto confidenceOpt = link.confidence();
    if (confidenceOpt.has_value()) {
      hasConfidence = true;
      confidence = static_cast<float>(confidenceOpt.value());
    }
    NSString *metaJson = slmMetaJsonFromObject(link.meta());
    std::string meta = metaJson.length > 0 ? std::string(metaJson.UTF8String ?: "") : std::string();

    PaSegmentLink created;
    std::string err;
    if (!slm_add_link(mapId, textSegmentId, speechSegmentId, link.linkType().UTF8String ?: "",
                      hasConfidence, confidence, meta, &created, &err)) {
      slmRejectFromError(reject, err);
      return;
    }
    resolve(slmLinkToDict(created));
  } @catch (NSException *exception) {
    reject(@"SEGMENT_LINK_INTERNAL_ERROR", exception.reason, nil);
  }
#else
  reject(@"SEGMENT_LINK_INTERNAL_ERROR", @"SegmentLinkMap unavailable", nil);
#endif
}

- (void)addSegmentLinks:(NSString *)linkMapId
                  links:(NSArray *)links
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  @try {
    NSMutableArray *created = [NSMutableArray arrayWithCapacity:links.count];
    for (id item in links) {
      if (![item isKindOfClass:[NSDictionary class]]) {
        reject(@"SEGMENT_LINK_INVALID", @"links[] must contain objects", nil);
        return;
      }
      NSDictionary *link = (NSDictionary *)item;
      std::string mapId = linkMapId.UTF8String ?: "";
      std::string textSegmentId = [link[@"textSegmentId"] isKindOfClass:[NSString class]]
                                    ? std::string([(NSString *)link[@"textSegmentId"] UTF8String] ?: "")
                                    : std::string();
      std::string speechSegmentId = [link[@"speechSegmentId"] isKindOfClass:[NSString class]]
                                      ? std::string([(NSString *)link[@"speechSegmentId"] UTF8String] ?: "")
                                      : std::string();
      NSString *linkType =
        [link[@"linkType"] isKindOfClass:[NSString class]] ? link[@"linkType"] : @"";
      bool hasConfidence = false;
      float confidence = 0.f;
      id confidenceObj = link[@"confidence"];
      if ([confidenceObj isKindOfClass:[NSNumber class]]) {
        hasConfidence = true;
        confidence = [(NSNumber *)confidenceObj floatValue];
      }
      NSString *metaJson = slmMetaJsonFromObject(link[@"meta"]);
      std::string meta = metaJson.length > 0 ? std::string(metaJson.UTF8String ?: "") : std::string();

      PaSegmentLink createdLink;
      std::string err;
      if (!slm_add_link(mapId, textSegmentId, speechSegmentId, linkType.UTF8String ?: "",
                        hasConfidence, confidence, meta, &createdLink, &err)) {
        slmRejectFromError(reject, err);
        return;
      }
      [created addObject:slmLinkToDict(createdLink)];
    }
    resolve(@{ @"links": created });
  } @catch (NSException *exception) {
    reject(@"SEGMENT_LINK_INTERNAL_ERROR", exception.reason, nil);
  }
#else
  reject(@"SEGMENT_LINK_INTERNAL_ERROR", @"SegmentLinkMap unavailable", nil);
#endif
}

- (void)removeSegmentLink:(NSString *)linkMapId
                   linkId:(NSString *)linkId
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  @try {
    std::string err;
    if (!slm_remove_link(linkMapId.UTF8String ?: "", linkId.UTF8String ?: "", &err)) {
      slmRejectFromError(reject, err);
      return;
    }
    resolve(nil);
  } @catch (NSException *exception) {
    reject(@"SEGMENT_LINK_INTERNAL_ERROR", exception.reason, nil);
  }
#else
  reject(@"SEGMENT_LINK_INTERNAL_ERROR", @"SegmentLinkMap unavailable", nil);
#endif
}

- (void)getSpeechSegmentsForText:(NSString *)linkMapId
                   textSegmentId:(NSString *)textSegmentId
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  @try {
    std::string err;
    auto links = slm_get_speech_for_text(linkMapId.UTF8String ?: "", textSegmentId.UTF8String ?: "",
                                         &err);
    if (!err.empty() && links.empty()) {
      slmRejectFromError(reject, err);
      return;
    }
    NSMutableArray *arr = [NSMutableArray arrayWithCapacity:links.size()];
    for (const auto &l : links) {
      [arr addObject:slmLinkToDict(l)];
    }
    resolve(arr);
  } @catch (NSException *exception) {
    reject(@"SEGMENT_LINK_INTERNAL_ERROR", exception.reason, nil);
  }
#else
  reject(@"SEGMENT_LINK_INTERNAL_ERROR", @"SegmentLinkMap unavailable", nil);
#endif
}

- (void)getTextSegmentsForSpeech:(NSString *)linkMapId
                 speechSegmentId:(NSString *)speechSegmentId
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  @try {
    std::string err;
    auto links = slm_get_text_for_speech(linkMapId.UTF8String ?: "",
                                         speechSegmentId.UTF8String ?: "", &err);
    if (!err.empty() && links.empty()) {
      slmRejectFromError(reject, err);
      return;
    }
    NSMutableArray *arr = [NSMutableArray arrayWithCapacity:links.size()];
    for (const auto &l : links) {
      [arr addObject:slmLinkToDict(l)];
    }
    resolve(arr);
  } @catch (NSException *exception) {
    reject(@"SEGMENT_LINK_INTERNAL_ERROR", exception.reason, nil);
  }
#else
  reject(@"SEGMENT_LINK_INTERNAL_ERROR", @"SegmentLinkMap unavailable", nil);
#endif
}

- (void)getAllSegmentLinks:(NSString *)linkMapId
                startIndex:(double)startIndex
                  maxCount:(double)maxCount
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  @try {
    std::string err;
    auto links = slm_get_all(linkMapId.UTF8String ?: "", (int)startIndex, (int)maxCount, &err);
    if (!err.empty() && links.empty() && startIndex == 0) {
      slmRejectFromError(reject, err);
      return;
    }
    NSMutableArray *arr = [NSMutableArray arrayWithCapacity:links.size()];
    for (const auto &l : links) {
      [arr addObject:slmLinkToDict(l)];
    }
    resolve(arr);
  } @catch (NSException *exception) {
    reject(@"SEGMENT_LINK_INTERNAL_ERROR", exception.reason, nil);
  }
#else
  reject(@"SEGMENT_LINK_INTERNAL_ERROR", @"SegmentLinkMap unavailable", nil);
#endif
}

- (void)getSegmentLinkMapInfo:(NSString *)linkMapId
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  @try {
    PaSegmentLinkMapInfo info;
    std::string err;
    if (!slm_get_info(linkMapId.UTF8String ?: "", &info, &err)) {
      slmRejectFromError(reject, err);
      return;
    }
    NSMutableDictionary *dict = [@{
      @"linkMapId": [NSString stringWithUTF8String:info.linkMapId.c_str()] ?: @"",
      @"linkCount": @(info.linkCount),
    } mutableCopy];
    if (info.textBufferId.has_value()) {
      dict[@"textBufferId"] = [NSString stringWithUTF8String:info.textBufferId->c_str()] ?: @"";
    }
    if (info.audioBufferId.has_value()) {
      dict[@"audioBufferId"] = [NSString stringWithUTF8String:info.audioBufferId->c_str()] ?: @"";
    }
    resolve(dict);
  } @catch (NSException *exception) {
    reject(@"SEGMENT_LINK_INTERNAL_ERROR", exception.reason, nil);
  }
#else
  reject(@"SEGMENT_LINK_INTERNAL_ERROR", @"SegmentLinkMap unavailable", nil);
#endif
}

- (void)releaseSegmentLinkMap:(NSString *)linkMapId
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  @try {
    slm_release(linkMapId.UTF8String ?: "");
    resolve(nil);
  } @catch (NSException *exception) {
    reject(@"SEGMENT_LINK_INTERNAL_ERROR", exception.reason, nil);
  }
#else
  reject(@"SEGMENT_LINK_INTERNAL_ERROR", @"SegmentLinkMap unavailable", nil);
#endif
}

@end
