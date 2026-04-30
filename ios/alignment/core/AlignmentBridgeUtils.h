#pragma once

#ifdef __OBJC__
@class NSString;
@class NSDictionary;
@class NSArray;
#elif defined(__cplusplus)
class NSString;
class NSDictionary;
#else
typedef struct NSString NSString;
typedef struct NSDictionary NSDictionary;
#endif

#ifdef __cplusplus

#include "../../../android/src/main/cpp/alignment/sherpa_onnx_alignment_engine.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace sherpaonnx {
namespace alignment {
namespace bridge {

struct PcmSliceDescriptor {
	std::string audioBufferId;
	int32_t startSample;
	int32_t sampleCount;
};

std::vector<int32_t> ParseSegmentSampleCounts(NSDictionary *options);
std::vector<float> ParseFloatSamples(NSArray *samples);
int32_t ParseEstimatedSampleRate(NSDictionary *options, int32_t fallbackSampleRate);
std::string ParseAlignmentModelPath(NSDictionary *options);
PcmSliceDescriptor ParsePcmSliceDescriptor(NSDictionary *pcm);
std::string ParseSegmentationBufferId(NSDictionary *options);
std::string ParseSegmentationSource(NSDictionary *options);
int32_t ParseMinAnchors(NSDictionary *options, int32_t defaultValue = 2);
std::string NormalizeMode(NSString *mode);
std::string NormalizeGranularity(NSString *granularity);

}  // namespace bridge
}  // namespace alignment
}  // namespace sherpaonnx

#endif
