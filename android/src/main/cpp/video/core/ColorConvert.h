#pragma once

#include "VideoTypes.h"
#include "core/AlignedBuffer.h"

namespace sherpa_onnx {
namespace video {

/** libyuv is the only conversion path. */
class ColorConvert {
 public:
  static const char* MatrixName(ColorMatrix m);
  static ColorMatrix DefaultMatrixForHeight(int height);

  static Status Nv12ToRgb24(const Nv12View& src, PackedPlane* dst,
                            ColorMatrix matrix, ColorRange range, bool packed);

  /** Gray8 is the Y plane (copy / rotate / scale). */
  static Status Nv12ToGray8(const Nv12View& src, PackedPlane* dst,
                            const VideoTransform& transform, int maxSide,
                            bool packed);

  static Status ScaleNv12(const Nv12View& src, MutableNv12* dst);

  static Status RotateNv12(const Nv12View& src, MutableNv12* dst,
                           const VideoTransform& transform);

  /**
   * Convert NV12 → requested format, applying transform then optional maxSide
   * (longest edge). packed=true forces stride == width * bpp.
   */
  static Status Convert(const Nv12View& src, VideoPixelFormat format,
                        const VideoTransform& transform, int maxSide,
                        bool packed, AlignedBuffer* storage,
                        VideoFrameView* out);
};

}  // namespace video
}  // namespace sherpa_onnx
