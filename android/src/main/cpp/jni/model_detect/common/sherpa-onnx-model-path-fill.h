#ifndef SHERPA_ONNX_MODEL_PATH_FILL_H
#define SHERPA_ONNX_MODEL_PATH_FILL_H

#include "sherpa-onnx-model-detect.h"
#include "sherpa-onnx-validate-online-stt.h"
#include <map>
#include <string>

namespace sherpaonnx {

void FillSttModelPathsFromStringMap(
    const std::map<std::string, std::string>& paths,
    SttModelPaths& out
);

void FillTtsModelPathsFromStringMap(
    const std::map<std::string, std::string>& paths,
    TtsModelPaths& out
);

void FillVadModelPathsFromStringMap(
    const std::map<std::string, std::string>& paths,
    VadModelPaths& out
);

void FillEnhancementModelPathsFromStringMap(
    const std::map<std::string, std::string>& paths,
    EnhancementModelPaths& out
);

void FillSeparationModelPathsFromStringMap(
    const std::map<std::string, std::string>& paths,
    SeparationModelPaths& out
);

void FillPunctuationModelPathsFromStringMap(
    const std::map<std::string, std::string>& paths,
    PunctuationModelPaths& out
);

void FillAlignmentModelPathsFromStringMap(
    const std::map<std::string, std::string>& paths,
    AlignmentModelPaths& out
);

void FillOnlineSttModelPathsFromStringMap(
    const std::map<std::string, std::string>& paths,
    OnlineSttModelPaths& out
);

std::map<std::string, std::string> SttModelPathsToStringMap(const SttModelPaths& paths);
std::map<std::string, std::string> TtsModelPathsToStringMap(const TtsModelPaths& paths);
std::map<std::string, std::string> VadModelPathsToStringMap(const VadModelPaths& paths);
std::map<std::string, std::string> EnhancementModelPathsToStringMap(
    const EnhancementModelPaths& paths);
std::map<std::string, std::string> SeparationModelPathsToStringMap(
    const SeparationModelPaths& paths);
std::map<std::string, std::string> SpeakerEmbeddingModelPathsToStringMap(
    const SpeakerEmbeddingModelPaths& paths);
std::map<std::string, std::string> PunctuationModelPathsToStringMap(
    const PunctuationModelPaths& paths);
std::map<std::string, std::string> AlignmentModelPathsToStringMap(
    const AlignmentModelPaths& paths);

}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_MODEL_PATH_FILL_H
