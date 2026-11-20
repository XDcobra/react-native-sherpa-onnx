/**
 * onnx-model-metadata.h
 *
 * Reads custom metadata (ModelProto.metadata_props) and small model-side
 * headers from model files without loading them into ONNX Runtime. The
 * protobuf is scanned field by field and large fields (the graph, external
 * data) are skipped by seeking, so the cost does not grow with model size.
 * No ORT or protobuf dependency.
 */
#ifndef SHERPA_ONNX_ONNX_MODEL_METADATA_H
#define SHERPA_ONNX_ONNX_MODEL_METADATA_H

#include <cstdint>
#include <string>
#include <unordered_map>

namespace sherpaonnx {
namespace model_detect {

/**
 * Reads all `metadata_props` key/value pairs of the `.onnx` file at `path`.
 * Returns false when the file cannot be opened or is not a well-formed
 * protobuf; `out` then holds the pairs read before the error.
 */
bool ReadOnnxMetadataProps(const std::string& path,
                           std::unordered_map<std::string, std::string>* out);

/** Integer value of metadata `key`, or `fallback` when missing or not an integer. */
int32_t ReadOnnxMetadataInt(const std::string& path, const std::string& key,
                            int32_t fallback);

/**
 * Speaker count from a Supertonic `voice.bin` header (six int64 dims: ttl
 * then dp shape; dims[0] is the speaker count). -1 when the header is invalid.
 */
int32_t ReadSupertonicVoiceStyleSpeakerCount(const std::string& path);

}  // namespace model_detect
}  // namespace sherpaonnx

#endif  // SHERPA_ONNX_ONNX_MODEL_METADATA_H
