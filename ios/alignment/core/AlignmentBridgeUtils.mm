#import <Foundation/Foundation.h>

#include "AlignmentBridgeUtils.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace sherpaonnx {
namespace alignment {
namespace bridge {

static NSArray *SubtitleItemsToNSArray(
    const std::vector<sherpa_onnx::alignment::SubtitleItem> &items) {
  NSMutableArray *array = [NSMutableArray arrayWithCapacity:items.size()];
  for (const auto &item : items) {
    [array addObject:@{
      @"text": [NSString stringWithUTF8String:item.text.c_str()] ?: @"",
      @"start": @(item.start_s),
      @"end": @(item.end_s),
    }];
  }
  return array;
}

NSDictionary *AlignmentResultToNSDictionary(
    const sherpa_onnx::alignment::AlignmentResult &result) {
  return @{
    @"subtitles": SubtitleItemsToNSArray(result.subtitles),
    @"timingMode": [NSString stringWithUTF8String:result.timing_mode.c_str()] ?: @"",
  };
}

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
  NSString *path = [options[@"alignmentModelPath"] isKindOfClass:[NSString class]]
      ? options[@"alignmentModelPath"]
      : nil;
  NSString *trimmed = path != nil
      ? [path stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]
      : @"";
  if (trimmed == nil || trimmed.length == 0) {
    throw std::runtime_error("ALIGNMENT_MODEL_MISSING: Provide options.alignmentModelPath for accurate alignment.");
  }
  return std::string([trimmed UTF8String]);
}

std::string NormalizeMode(NSString *mode) {
  NSString *m = [mode isKindOfClass:[NSString class]]
      ? [[mode lowercaseString] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]
      : @"";
  if ([m isEqualToString:@"proportional"]) return "proportional";
  if ([m isEqualToString:@"estimated"]) return "estimated";
  if ([m isEqualToString:@"accurate"]) return "accurate";
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
