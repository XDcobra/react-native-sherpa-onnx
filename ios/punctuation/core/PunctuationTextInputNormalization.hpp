#pragma once

#import <Foundation/Foundation.h>

#include <string>

namespace punct_text_input_normalization {

inline std::string resolve_mode(NSString *mode) {
  if (mode == nil || mode.length == 0) {
    return "lower";
  }
  std::string resolved = mode.UTF8String ?: "lower";
  if (resolved == "none") {
    return "none";
  }
  return "lower";
}

inline std::string normalize(const std::string &text, const std::string &mode) {
  if (mode == "none" || text.empty()) {
    return text;
  }
  NSString *ns = [[NSString alloc] initWithBytes:text.data()
                                          length:text.size()
                                        encoding:NSUTF8StringEncoding];
  if (ns == nil) {
    return text;
  }
  NSString *lower = [ns lowercaseString];
  if (lower == nil) {
    return text;
  }
  return std::string(lower.UTF8String ?: "");
}

}  // namespace punct_text_input_normalization
