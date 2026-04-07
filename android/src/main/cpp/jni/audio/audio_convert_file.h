#pragma once
#include <string>
#include <vector>

std::string sherpa_audio_convert_to_format(const char* inputPath, const char* outputPath, const char* formatHint, int outputSampleRateHz);
std::string sherpa_audio_decode_file_to_float_mono(const char* inputPath, int targetSampleRateHz, std::vector<float>* outSamples, int* outSampleRate);
std::string sherpa_audio_convert_to_wav16k_mono(const char* inputPath, const char* outputPath);
