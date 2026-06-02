#import "../../SherpaOnnx.h"

#ifdef __cplusplus
#include <algorithm>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "../core/PaSegmentLink.h"

struct PaSegmentLinkMapStore {
  std::string linkMapId;
  std::optional<std::string> textBufferId;
  std::optional<std::string> audioBufferId;
  std::unordered_map<std::string, PaSegmentLink> links;
  std::unordered_multimap<std::string, std::string> textIndex;
  std::unordered_multimap<std::string, std::string> speechIndex;
  std::unordered_set<std::string> pairTypeIndex;
  std::vector<std::string> insertionOrder;
};

static std::unordered_map<std::string, PaSegmentLinkMapStore> g_segment_link_maps;
static std::mutex g_segment_link_maps_mutex;

extern "C" void slm_release_all_link_maps() {
  std::lock_guard<std::mutex> lock(g_segment_link_maps_mutex);
  g_segment_link_maps.clear();
}

static std::string slmNewId(const char *prefix) {
  NSString *uuid = [[NSUUID UUID] UUIDString] ?: @"";
  return std::string(prefix) + "_" + (uuid.UTF8String ?: "");
}

static const char *slmLinkTypeRaw(PaSegmentLinkType type) {
  switch (type) {
    case PaSegmentLinkType::Alignment:
      return "alignment";
    case PaSegmentLinkType::Proportional:
      return "proportional";
    case PaSegmentLinkType::VadAssisted:
      return "vad_assisted";
    case PaSegmentLinkType::Sequential:
      return "sequential";
    case PaSegmentLinkType::TtsProduced:
      return "tts_produced";
    case PaSegmentLinkType::SttProduced:
      return "stt_produced";
    case PaSegmentLinkType::UserDefined:
      return "user_defined";
  }
  return "user_defined";
}

static bool slmParseLinkType(NSString *raw, PaSegmentLinkType *out) {
  NSString *normalized = [[raw ?: @"" lowercaseString] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if ([normalized isEqualToString:@"alignment"]) {
    *out = PaSegmentLinkType::Alignment;
    return true;
  }
  if ([normalized isEqualToString:@"proportional"]) {
    *out = PaSegmentLinkType::Proportional;
    return true;
  }
  if ([normalized isEqualToString:@"vad_assisted"]) {
    *out = PaSegmentLinkType::VadAssisted;
    return true;
  }
  if ([normalized isEqualToString:@"sequential"]) {
    *out = PaSegmentLinkType::Sequential;
    return true;
  }
  if ([normalized isEqualToString:@"tts_produced"]) {
    *out = PaSegmentLinkType::TtsProduced;
    return true;
  }
  if ([normalized isEqualToString:@"stt_produced"]) {
    *out = PaSegmentLinkType::SttProduced;
    return true;
  }
  if ([normalized isEqualToString:@"user_defined"]) {
    *out = PaSegmentLinkType::UserDefined;
    return true;
  }
  return false;
}

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
    @"linkType": [NSString stringWithUTF8String:slmLinkTypeRaw(link.linkType)] ?: @"user_defined",
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

static void slmRemoveIndexEntries(
  std::unordered_multimap<std::string, std::string> &index,
  const std::string &key,
  const std::string &linkId
) {
  auto range = index.equal_range(key);
  for (auto it = range.first; it != range.second;) {
    if (it->second == linkId) {
      it = index.erase(it);
    } else {
      ++it;
    }
  }
}

static std::string slmPairTypeKey(
  const std::string &textSegmentId,
  const std::string &speechSegmentId,
  PaSegmentLinkType linkType
) {
  return textSegmentId + "::" + speechSegmentId + "::" + slmLinkTypeRaw(linkType);
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

    PaSegmentLinkMapStore store;
    store.linkMapId = slmNewId("lnkmap");
    if ([textBufferId isKindOfClass:[NSString class]] && textBufferId.length > 0) {
      store.textBufferId = std::string(textBufferId.UTF8String ?: "");
    }
    if ([audioBufferId isKindOfClass:[NSString class]] && audioBufferId.length > 0) {
      store.audioBufferId = std::string(audioBufferId.UTF8String ?: "");
    }

    {
      std::lock_guard<std::mutex> lock(g_segment_link_maps_mutex);
      g_segment_link_maps[store.linkMapId] = std::move(store);
    }

    resolve(@{ @"linkMapId": [NSString stringWithUTF8String:store.linkMapId.c_str()] ?: @"" });
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
    std::string textSegmentId = textSegmentIdRaw != nil
      ? std::string([textSegmentIdRaw UTF8String] ?: "")
      : std::string();
    std::string speechSegmentId = speechSegmentIdRaw != nil
      ? std::string([speechSegmentIdRaw UTF8String] ?: "")
      : std::string();

    if (textSegmentId.empty()) {
      reject(@"SEGMENT_LINK_INVALID", @"textSegmentId must be non-empty", nil);
      return;
    }
    if (speechSegmentId.empty()) {
      reject(@"SEGMENT_LINK_INVALID", @"speechSegmentId must be non-empty", nil);
      return;
    }

    PaSegmentLinkType linkType;
    if (!slmParseLinkType(link.linkType(), &linkType)) {
      reject(@"SEGMENT_LINK_INVALID", @"linkType is invalid", nil);
      return;
    }

    std::lock_guard<std::mutex> lock(g_segment_link_maps_mutex);
    auto it = g_segment_link_maps.find(mapId);
    if (it == g_segment_link_maps.end()) {
      reject(@"SEGMENT_LINK_MAP_NOT_FOUND", [NSString stringWithFormat:@"Link map not found: %@", linkMapId], nil);
      return;
    }

    auto &store = it->second;
    std::string pairKey = slmPairTypeKey(textSegmentId, speechSegmentId, linkType);
    if (store.pairTypeIndex.find(pairKey) != store.pairTypeIndex.end()) {
      reject(@"SEGMENT_LINK_INVALID", @"duplicate (textSegmentId, speechSegmentId, linkType) is not allowed", nil);
      return;
    }

    PaSegmentLink created;
    created.linkId = slmNewId("lnk");
    created.textSegmentId = textSegmentId;
    created.speechSegmentId = speechSegmentId;
    created.linkType = linkType;

    auto confidenceOpt = link.confidence();
    if (confidenceOpt.has_value()) {
      created.confidence = static_cast<float>(confidenceOpt.value());
    }

    NSString *metaJson = slmMetaJsonFromObject(link.meta());
    if (metaJson.length > 0) {
      created.metaJson = std::string(metaJson.UTF8String ?: "");
    }

    store.links[created.linkId] = created;
    store.insertionOrder.push_back(created.linkId);
    store.pairTypeIndex.insert(pairKey);
    store.textIndex.emplace(created.textSegmentId, created.linkId);
    store.speechIndex.emplace(created.speechSegmentId, created.linkId);

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

      if (textSegmentId.empty()) {
        reject(@"SEGMENT_LINK_INVALID", @"textSegmentId must be non-empty", nil);
        return;
      }
      if (speechSegmentId.empty()) {
        reject(@"SEGMENT_LINK_INVALID", @"speechSegmentId must be non-empty", nil);
        return;
      }

      PaSegmentLinkType linkType;
      if (!slmParseLinkType([link[@"linkType"] isKindOfClass:[NSString class]] ? link[@"linkType"] : @"", &linkType)) {
        reject(@"SEGMENT_LINK_INVALID", @"linkType is invalid", nil);
        return;
      }

      std::lock_guard<std::mutex> lock(g_segment_link_maps_mutex);
      auto it = g_segment_link_maps.find(mapId);
      if (it == g_segment_link_maps.end()) {
        reject(@"SEGMENT_LINK_MAP_NOT_FOUND", [NSString stringWithFormat:@"Link map not found: %@", linkMapId], nil);
        return;
      }

      auto &store = it->second;
      std::string pairKey = slmPairTypeKey(textSegmentId, speechSegmentId, linkType);
      if (store.pairTypeIndex.find(pairKey) != store.pairTypeIndex.end()) {
        reject(@"SEGMENT_LINK_INVALID", @"duplicate (textSegmentId, speechSegmentId, linkType) is not allowed", nil);
        return;
      }

      PaSegmentLink createdLink;
      createdLink.linkId = slmNewId("lnk");
      createdLink.textSegmentId = textSegmentId;
      createdLink.speechSegmentId = speechSegmentId;
      createdLink.linkType = linkType;

      id confidenceObj = link[@"confidence"];
      if ([confidenceObj isKindOfClass:[NSNumber class]]) {
        createdLink.confidence = [(NSNumber *)confidenceObj floatValue];
      }

      NSString *metaJson = slmMetaJsonFromObject(link[@"meta"]);
      if (metaJson.length > 0) {
        createdLink.metaJson = std::string(metaJson.UTF8String ?: "");
      }

      store.links[createdLink.linkId] = createdLink;
      store.insertionOrder.push_back(createdLink.linkId);
      store.pairTypeIndex.insert(pairKey);
      store.textIndex.emplace(createdLink.textSegmentId, createdLink.linkId);
      store.speechIndex.emplace(createdLink.speechSegmentId, createdLink.linkId);

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
    std::string mapId = linkMapId.UTF8String ?: "";
    std::string linkIdRaw = linkId.UTF8String ?: "";

    std::lock_guard<std::mutex> lock(g_segment_link_maps_mutex);
    auto it = g_segment_link_maps.find(mapId);
    if (it == g_segment_link_maps.end()) {
      reject(@"SEGMENT_LINK_MAP_NOT_FOUND", [NSString stringWithFormat:@"Link map not found: %@", linkMapId], nil);
      return;
    }

    auto &store = it->second;
    auto linkIt = store.links.find(linkIdRaw);
    if (linkIt == store.links.end()) {
      resolve(nil);
      return;
    }

    PaSegmentLink removed = linkIt->second;
    store.links.erase(linkIt);

    std::string pairKey = slmPairTypeKey(removed.textSegmentId, removed.speechSegmentId, removed.linkType);
    store.pairTypeIndex.erase(pairKey);
    slmRemoveIndexEntries(store.textIndex, removed.textSegmentId, removed.linkId);
    slmRemoveIndexEntries(store.speechIndex, removed.speechSegmentId, removed.linkId);
    store.insertionOrder.erase(
      std::remove(store.insertionOrder.begin(), store.insertionOrder.end(), removed.linkId),
      store.insertionOrder.end()
    );

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
    std::string mapId = linkMapId.UTF8String ?: "";
    std::string textId = textSegmentId.UTF8String ?: "";

    NSMutableArray *out = [NSMutableArray array];
    std::lock_guard<std::mutex> lock(g_segment_link_maps_mutex);
    auto it = g_segment_link_maps.find(mapId);
    if (it == g_segment_link_maps.end()) {
      reject(@"SEGMENT_LINK_MAP_NOT_FOUND", [NSString stringWithFormat:@"Link map not found: %@", linkMapId], nil);
      return;
    }

    auto range = it->second.textIndex.equal_range(textId);
    for (auto idx = range.first; idx != range.second; ++idx) {
      auto linkIt = it->second.links.find(idx->second);
      if (linkIt != it->second.links.end()) {
        [out addObject:slmLinkToDict(linkIt->second)];
      }
    }

    resolve(@{ @"links": out });
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
    std::string mapId = linkMapId.UTF8String ?: "";
    std::string speechId = speechSegmentId.UTF8String ?: "";

    NSMutableArray *out = [NSMutableArray array];
    std::lock_guard<std::mutex> lock(g_segment_link_maps_mutex);
    auto it = g_segment_link_maps.find(mapId);
    if (it == g_segment_link_maps.end()) {
      reject(@"SEGMENT_LINK_MAP_NOT_FOUND", [NSString stringWithFormat:@"Link map not found: %@", linkMapId], nil);
      return;
    }

    auto range = it->second.speechIndex.equal_range(speechId);
    for (auto idx = range.first; idx != range.second; ++idx) {
      auto linkIt = it->second.links.find(idx->second);
      if (linkIt != it->second.links.end()) {
        [out addObject:slmLinkToDict(linkIt->second)];
      }
    }

    resolve(@{ @"links": out });
  } @catch (NSException *exception) {
    reject(@"SEGMENT_LINK_INTERNAL_ERROR", exception.reason, nil);
  }
#else
  reject(@"SEGMENT_LINK_INTERNAL_ERROR", @"SegmentLinkMap unavailable", nil);
#endif
}

- (void)getAllSegmentLinks:(NSString *)linkMapId
                startIndex:(NSNumber *)startIndex
                  maxCount:(NSNumber *)maxCount
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  @try {
    const double startIndexVal = startIndex != nil ? startIndex.doubleValue : 0.0;
    const double maxCountVal = maxCount != nil ? maxCount.doubleValue : 4096.0;
    int start = std::max(0, (int)startIndexVal);
    int count = std::max(0, (int)maxCountVal);

    NSMutableArray *out = [NSMutableArray array];
    std::lock_guard<std::mutex> lock(g_segment_link_maps_mutex);
    auto it = g_segment_link_maps.find(linkMapId.UTF8String ?: "");
    if (it == g_segment_link_maps.end()) {
      reject(@"SEGMENT_LINK_MAP_NOT_FOUND", [NSString stringWithFormat:@"Link map not found: %@", linkMapId], nil);
      return;
    }

    auto &store = it->second;
    int end = std::min((int)store.insertionOrder.size(), start + count);
    for (int i = start; i < end; ++i) {
      const std::string &linkIdRaw = store.insertionOrder[(size_t)i];
      auto linkIt = store.links.find(linkIdRaw);
      if (linkIt != store.links.end()) {
        [out addObject:slmLinkToDict(linkIt->second)];
      }
    }

    resolve(@{ @"links": out });
  } @catch (NSException *exception) {
    reject(@"SEGMENT_LINK_INTERNAL_ERROR", exception.reason, nil);
  }
#else
  reject(@"SEGMENT_LINK_INTERNAL_ERROR", @"SegmentLinkMap unavailable", nil);
#endif
}

- (void)getSegmentLinkCount:(NSString *)linkMapId
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
#ifdef __cplusplus
  @try {
    std::lock_guard<std::mutex> lock(g_segment_link_maps_mutex);
    auto it = g_segment_link_maps.find(linkMapId.UTF8String ?: "");
    if (it == g_segment_link_maps.end()) {
      reject(@"SEGMENT_LINK_MAP_NOT_FOUND", [NSString stringWithFormat:@"Link map not found: %@", linkMapId], nil);
      return;
    }
    resolve(@((int)it->second.links.size()));
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
    std::lock_guard<std::mutex> lock(g_segment_link_maps_mutex);
    auto it = g_segment_link_maps.find(linkMapId.UTF8String ?: "");
    if (it == g_segment_link_maps.end()) {
      reject(@"SEGMENT_LINK_MAP_NOT_FOUND", [NSString stringWithFormat:@"Link map not found: %@", linkMapId], nil);
      return;
    }

    NSMutableDictionary *out = [@{
      @"linkMapId": [NSString stringWithUTF8String:it->second.linkMapId.c_str()] ?: @"",
      @"linkCount": @((int)it->second.links.size()),
    } mutableCopy];

    if (it->second.textBufferId.has_value()) {
      out[@"textBufferId"] = [NSString stringWithUTF8String:it->second.textBufferId->c_str()] ?: @"";
    }
    if (it->second.audioBufferId.has_value()) {
      out[@"audioBufferId"] = [NSString stringWithUTF8String:it->second.audioBufferId->c_str()] ?: @"";
    }

    resolve(out);
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
    std::lock_guard<std::mutex> lock(g_segment_link_maps_mutex);
    g_segment_link_maps.erase(linkMapId.UTF8String ?: "");
    resolve(nil);
  } @catch (NSException *exception) {
    reject(@"SEGMENT_LINK_INTERNAL_ERROR", exception.reason, nil);
  }
#else
  reject(@"SEGMENT_LINK_INTERNAL_ERROR", @"SegmentLinkMap unavailable", nil);
#endif
}

@end
