/**
 * Parse ocr_manifest.json for granite-docling / doc_vlm packs.
 * Hand-rolled JSON (no external dependency), same style as DoctrManifest.
 */
#pragma once

#include <array>
#include <string>

namespace sherpa_onnx {
namespace ocr {
namespace doc_vlm {

struct DocVlmManifest {
  std::string family;
  std::string arch;
  std::string onnx_dtype;

  int image_size = 0;
  int patch_size = 0;
  int scale_factor = 0;
  int image_seq_len = 0;
  std::array<float, 3> mean = {0.5f, 0.5f, 0.5f};
  std::array<float, 3> std = {0.5f, 0.5f, 0.5f};
  float rescale_factor = 0.f;
  int size_longest_edge = 0;
  int max_image_size_longest_edge = 0;
  bool do_image_splitting = false;

  int hidden_size = 0;
  int num_hidden_layers = 0;
  int num_key_value_heads = 0;
  int head_dim = 0;
  int vocab_size = 0;
  int max_position_embeddings = 0;

  int bos_token_id = 0;
  int eos_token_id = 0;
  int image_token_id = 0;
  std::string bos_token;
  std::string eos_token;
  std::string image_token;
};

/**
 * Parse ocr_manifest.json from a model directory.
 * Throws std::runtime_error when the file is missing or the granite-docling
 * contract (family, arch, dtype, vision/text sizes) does not hold.
 */
DocVlmManifest ParseDocVlmManifest(const std::string& model_dir);

/** Parse an absolute path to ocr_manifest.json. */
DocVlmManifest ParseDocVlmManifestFile(const std::string& manifest_path);

}  // namespace doc_vlm
}  // namespace ocr
}  // namespace sherpa_onnx
