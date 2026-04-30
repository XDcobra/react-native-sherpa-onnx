#import <Foundation/Foundation.h>

#include "AlignmentBridgeUtils.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace sherpaonnx {
namespace alignment {
namespace bridge {

std::vector<int32_t> ParseSegmentSampleCounts(NSDictionary *options) {
  if (options == nil) {
    throw std::runtime_error("ALIGNMENT_CHUNKS_MISSING: Provide options.segmentSampleCounts for estimated mode.");
  }

  id raw = options[@"segmentSampleCounts"];
  if (raw == nil) {
    id chunks = options[@"chunks"];
    if ([chunks isKindOfClass:[NSDictionary class]]) {
      raw = ((NSDictionary *)chunks)[@"segmentSampleCounts"];
    }
  }

  if (![raw isKindOfClass:[NSArray class]]) {
    throw std::runtime_error("ALIGNMENT_CHUNKS_MISSING: Provide options.segmentSampleCounts for estimated mode.");
  }

  NSArray *arr = (NSArray *)raw;
  std::vector<int32_t> out;
  out.reserve(arr.count);
  for (id v in arr) {
    if (![v isKindOfClass:[NSNumber class]]) {
      out.push_back(0);
      continue;
    }
    double x = [(NSNumber *)v doubleValue];
    if (!std::isfinite(x)) {
      out.push_back(0);
      continue;
    }
    int32_t n = static_cast<int32_t>(x);
    out.push_back(std::max<int32_t>(0, n));
  }
  return out;
}

int32_t ParseEstimatedSampleRate(
    NSDictionary *options,
    int32_t fallbackSampleRate) {
  if (options != nil) {
    id direct = options[@"sampleRate"];
    if ([direct isKindOfClass:[NSNumber class]]) {
      double v = [(NSNumber *)direct doubleValue];
      if (std::isfinite(v) && v > 0) {
        return static_cast<int32_t>(v);
      }
    }

    id chunks = options[@"chunks"];
    if ([chunks isKindOfClass:[NSDictionary class]]) {
      id nested = ((NSDictionary *)chunks)[@"sampleRate"];
      if ([nested isKindOfClass:[NSNumber class]]) {
        double v = [(NSNumber *)nested doubleValue];
        if (std::isfinite(v) && v > 0) {
          return static_cast<int32_t>(v);
        }
      }
    }
  }

  return fallbackSampleRate;
}

std::string ParseAlignmentModelPath(NSDictionary *options) {
  NSString *path = [options[@"modelPath"] isKindOfClass:[NSString class]]
      ? options[@"modelPath"]
      : nil;
  NSString *trimmed = path != nil
      ? [path stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]
      : @"";
  if (trimmed == nil || trimmed.length == 0) {
    throw std::runtime_error("ALIGNMENT_MODEL_MISSING: Provide options.modelPath for accurate alignment.");
  }
  return std::string([trimmed UTF8String]);
}

std::string ParseSegmentationBufferId(NSDictionary *options) {
  if (options == nil) {
    throw std::runtime_error("ALIGNMENT_ERROR: options.segmentationBufferId is required for mode=vad.");
  }
  NSString *value = [options[@"segmentationBufferId"] isKindOfClass:[NSString class]]
      ? options[@"segmentationBufferId"]
      : nil;
  NSString *trimmed = value != nil
      ? [value stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]
      : @"";
  if (trimmed.length > 0) {
    return std::string([trimmed UTF8String]);
  }
  throw std::runtime_error("ALIGNMENT_ERROR: options.segmentationBufferId is required for mode=vad.");
}

std::string ParseSegmentationSource(NSDictionary *options) {
  if (options == nil) return "";
  NSString *value = [options[@"segmentationSource"] isKindOfClass:[NSString class]]
      ? options[@"segmentationSource"]
      : nil;
  NSString *trimmed = value != nil
      ? [[value lowercaseString] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]
      : @"";
  return std::string([trimmed UTF8String]);
}

int32_t ParseMinAnchors(NSDictionary *options, int32_t defaultValue) {
  if (options == nil) {
    return defaultValue;
  }
  id raw = options[@"minAnchors"];
  if (raw == nil) {
    return defaultValue;
  }
  if (![raw isKindOfClass:[NSNumber class]]) {
    throw std::runtime_error("ALIGNMENT_ERROR: options.minAnchors must be an integer between 1 and 10.");
  }
  double value = [(NSNumber *)raw doubleValue];
  int32_t intValue = static_cast<int32_t>(value);
  if (!std::isfinite(value) || value != static_cast<double>(intValue) || intValue < 1 || intValue > 10) {
    throw std::runtime_error("ALIGNMENT_ERROR: options.minAnchors must be an integer between 1 and 10.");
  }
  return intValue;
}

std::string NormalizeMode(NSString *mode) {
  NSString *m = [mode isKindOfClass:[NSString class]]
      ? [[mode lowercaseString] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]
      : @"";
  if ([m isEqualToString:@"proportional"]) return "proportional";
  if ([m isEqualToString:@"estimated"]) return "estimated";
  if ([m isEqualToString:@"accurate"]) return "accurate";
  if ([m isEqualToString:@"vad"]) return "vad";
  throw std::runtime_error("Unsupported alignment mode");
}

std::string NormalizeGranularity(NSString *granularity) {
  NSString *g = [granularity isKindOfClass:[NSString class]]
      ? [[granularity lowercaseString] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]
      : @"";
  if (g == nil || g.length == 0 || [g isEqualToString:@"sentence"]) return "sentence";
  if ([g isEqualToString:@"word"]) return "word";
  if ([g isEqualToString:@"character"]) return "character";
  throw std::runtime_error("Unsupported alignment granularity");
}

}  // namespace bridge
}  // namespace alignment
}  // namespace sherpaonnx
