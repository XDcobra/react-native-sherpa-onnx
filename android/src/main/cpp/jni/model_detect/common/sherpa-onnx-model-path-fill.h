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

}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_MODEL_PATH_FILL_H
