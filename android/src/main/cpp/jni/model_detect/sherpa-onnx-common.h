#ifndef SHERPA_ONNX_COMMON_H
#define SHERPA_ONNX_COMMON_H

#include <string>

namespace sherpaonnx {

/**
 * Information about a detected model.
 */
struct DetectedModel {
    std::string type;      // Model type (e.g., "transducer", "paraformer", "nemo_ctc")
    std::string modelDir;  // Directory path where the model is located
};

} // namespace sherpaonnx

#endif // SHERPA_ONNX_COMMON_H
