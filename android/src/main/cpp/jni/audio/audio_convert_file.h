#pragma once
#include <string>

std::string sherpa_audio_convert_to_format(const char* inputPath, const char* outputPath, const char* formatHint, int outputSampleRateHz);

/**
 * Encode raw float32 PCM samples to an output file in the requested format.
 * Bypasses FFmpeg's input demuxer/decoder — samples are fed directly
 * to SwrContext (resampling) → encoder → output muxer.
 */
std::string sherpa_audio_convert_pcm_to_format(
    const float *samples,
    int numSamples,
    int sampleRate,
    int channelCount,
    const char *outputPath,
    const char *formatHint,
    int outputSampleRateHz);
