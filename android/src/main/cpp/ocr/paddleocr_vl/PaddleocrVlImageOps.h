#pragma once

#include <cstdint>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace paddleocr_vl {

struct PaddleocrVlPatches {
  /** pixel_values layout [P, 3, 14, 14] packed; caller adds batch dim. */
  std::vector<float> pixel_values;
  int src_h = 0;
  int src_w = 0;
  int resized_h = 0;
  int resized_w = 0;
  int grid_t = 1;
  int grid_h = 0;
  int grid_w = 0;
  int num_patches = 0;
  int effective_max_pixels = 0;
  bool upscaled = false;
};

struct SmartResizeSize {
  int height = 0;
  int width = 0;
};

constexpr int kSmartResizeFactor = 28;
constexpr int kMinPixels = 112896;
/** Official PaddleOCR-VL smart_resize ceiling (desktop / GPU). */
constexpr int kOfficialMaxPixels = 1003520;
/** Spotting task default (`28 * 28 * 2048`). */
constexpr int kSpottingMaxPixels = 1605632;
/** Suggested phone cap (512 visual tokens). Apps pass this via maxPixels. */
constexpr int kMobileMaxPixels = 401408;
/** 2× LANCZOS when both sides are below this (spotting, after crop). */
constexpr int kSpottingUpscaleBelow = 1500;

struct PaddleocrVlPreprocessOptions {
  int init_max_pixels = 0;
  int task_max_pixels = kOfficialMaxPixels;
  bool upscale_small_2x = false;
};

SmartResizeSize SmartResize(int height, int width, int factor = kSmartResizeFactor,
                            int min_pixels = kMinPixels,
                            int max_pixels = kOfficialMaxPixels);

/**
 * RGB8 → optional 2× LANCZOS + smart_resize + bicubic + /255 + mean/std 0.5
 * + 14×14 unfold, t=1.
 * `max_pixels` ≤ 0 uses kOfficialMaxPixels; values are clamped to
 * [kMinPixels, kSpottingMaxPixels].
 */
PaddleocrVlPatches PreprocessRgb(const uint8_t* rgb, int width, int height,
                                 int max_pixels = kOfficialMaxPixels);

PaddleocrVlPatches PreprocessRgb(const uint8_t* rgb, int width, int height,
                                 const PaddleocrVlPreprocessOptions& options);

/** Init cap vs task default: omit/0 → task default. */
int EffectiveMaxPixels(int init_cap, int task_default);

/** 2× LANCZOS-3. Used when spotting and both sides < 1500. */
std::vector<uint8_t> Upscale2xLanczos(const uint8_t* rgb, int width, int height);

}  // namespace paddleocr_vl
}  // namespace ocr
}  // namespace sherpa_onnx
