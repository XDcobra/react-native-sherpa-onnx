/**
 * Idefics3 image tiling for granite-docling: longest-edge resize, 512 grid,
 * Lanczos, rescale/normalize, and a bottom/right attention mask.
 */
#pragma once

#include <cstdint>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace doc_vlm {

struct DocVlmSize {
  int width = 0;
  int height = 0;
};

struct DocVlmGrid {
  int rows = 0;
  int cols = 0;
  int num_images = 1;
  int tile_w = 0;
  int tile_h = 0;
};

struct DocVlmTiles {
  int rows = 0;
  int cols = 0;
  int num_images = 0;
  int canvas_width = 0;
  int canvas_height = 0;
  /** [num_images, 3, tile, tile] NCHW, normalized. */
  std::vector<float> nchw;
  /** [num_images, tile, tile] 0/1. True on real pixels, false on pad. */
  std::vector<uint8_t> mask;
};

/** Step A: longest edge becomes `longest_edge`, including upscale. Odd side +1. */
DocVlmSize LongestEdgeSize(int width, int height, int longest_edge);

/** Step B: round each side up to a multiple of `multiple`, from a step-A size. */
DocVlmSize VisionEncoderSize(int width, int height, int multiple);

/**
 * Split a post-step-B canvas. Both sides ≤ tile → rows=0, cols=0, num_images=1.
 * Otherwise rows*cols crops plus one global image. Throws if rows or cols > 4.
 */
DocVlmGrid SplitGrid(int width, int height, int tile);

/**
 * RGB8 → tiles. `tile` is both the grid multiple and the encoder spatial size.
 * Mean/std are per-channel. Pad value after normalize is 0.
 */
DocVlmTiles PreprocessRgb(const uint8_t* rgb, int width, int height,
                          int longest_edge, int tile, float rescale_factor,
                          const float mean[3], const float stdev[3]);

}  // namespace doc_vlm
}  // namespace ocr
}  // namespace sherpa_onnx
