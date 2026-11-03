#pragma once

#import <Foundation/Foundation.h>
#include <string>

/** Convert RN meta dictionary ↔ opaque JSON stored in shared TxtLiveEntry TextSegment.metaJson. */
inline std::string txtMetaJsonFromDict(NSDictionary *meta) {
  if (meta == nil) return {};
  NSError *err = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:meta options:0 error:&err];
  if (!data || err) return {};
  return std::string((const char *)data.bytes, (size_t)data.length);
}

inline NSDictionary *txtMetaDictFromJson(const std::string &json) {
  if (json.empty()) return nil;
  NSData *data = [NSData dataWithBytes:json.data() length:json.size()];
  id obj = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  return [obj isKindOfClass:[NSDictionary class]] ? (NSDictionary *)obj : nil;
}
