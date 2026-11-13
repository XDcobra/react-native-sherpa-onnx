#ifndef SHERPA_ONNX_DIARIZATION_STREAMING_DIARIZER_FACTORY_H
#define SHERPA_ONNX_DIARIZATION_STREAMING_DIARIZER_FACTORY_H

#include "streaming-diarizer-interface.h"

#include <memory>
#include <string>

namespace sherpaonnx::diarization {

/**
 * Thin factory for streaming diarization backends.
 *
 * Today every detected streaming pack (including Nemotron-3) shares the
 * Sortformer ONNX contract, so this always returns SortformerStreamingModel.
 * Keep the hook so a future non-Sortformer graph can branch on `model_type`
 * without touching StreamingDiarizationWrapper buffering.
 */
std::unique_ptr<IStreamingDiarizer> CreateStreamingDiarizer(
    const std::string& model_type = "sortformer");

}  // namespace sherpaonnx::diarization

#endif  // SHERPA_ONNX_DIARIZATION_STREAMING_DIARIZER_FACTORY_H
