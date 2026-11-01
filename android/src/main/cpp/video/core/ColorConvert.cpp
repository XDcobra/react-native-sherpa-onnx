#include "core/ColorConvert.h"

#include <algorithm>
#include <string>
#include <utility>
#include <vector>

#include "libyuv/convert.h"
#include "libyuv/convert_argb.h"
#include "libyuv/convert_from.h"
#include "libyuv/planar_functions.h"
#include "libyuv/rotate.h"
#include "libyuv/scale.h"

namespace sherpa_onnx {
namespace video {
namespace {

// libyuv RGB24 is BGR in memory. RAW is R,G,B — what OCR / ImageBuffer need.
// NV12ToRAWMatrix(y,uv,dst, kYuvXxx) expands to NV21ToRGB24Matrix(..., kYvuXxx).
const libyuv::YuvConstants* LibyuvVuConstants(ColorMatrix matrix,
                                              ColorRange range) {
  switch (matrix) {
    case ColorMatrix::Bt709:
      return range == ColorRange::Full ? &libyuv::kYvuF709Constants
                                       : &libyuv::kYvuH709Constants;
    case ColorMatrix::Bt2020:
      return range == ColorRange::Full ? &libyuv::kYvuV2020Constants
                                       : &libyuv::kYvu2020Constants;
    case ColorMatrix::Bt601:
    default:
      return range == ColorRange::Full ? &libyuv::kYvuJPEGConstants
                                       : &libyuv::kYvuI601Constants;
  }
}

libyuv::RotationMode ToLibyuvRotation(int degrees) {
  switch (((degrees % 360) + 360) % 360) {
    case 90:
      return libyuv::kRotate90;
    case 180:
      return libyuv::kRotate180;
    case 270:
      return libyuv::kRotate270;
    default:
      return libyuv::kRotate0;
  }
}

void SwapIf90(int degrees, int* w, int* h) {
  const int d = ((degrees % 360) + 360) % 360;
  if (d == 90 || d == 270) {
    std::swap(*w, *h);
  }
}

int ScaleDim(int srcW, int srcH, int maxSide, int* outW, int* outH) {
  *outW = srcW;
  *outH = srcH;
  if (maxSide <= 0) {
    return 0;
  }
  const int longest = std::max(srcW, srcH);
  if (longest <= maxSide) {
    return 0;
  }
  *outW = std::max(1, (srcW * maxSide) / longest);
  *outH = std::max(1, (srcH * maxSide) / longest);
  // Even dims for NV12 chroma.
  *outW &= ~1;
  *outH &= ~1;
  if (*outW < 2) {
    *outW = 2;
  }
  if (*outH < 2) {
    *outH = 2;
  }
  return 1;
}

Status NeedNv12(const Nv12View& src, const char* what) {
  if (src.width <= 0 || src.height <= 0 || src.y.data == nullptr ||
      src.uv.data == nullptr || src.y.stride <= 0 || src.uv.stride <= 0) {
    return Status::Fail(kErrInvalidArgument, std::string("invalid NV12 for ") + what);
  }
  return Status::Ok();
}

Status YPlaneToGray8(const Nv12View& src, const VideoTransform& transform,
                     uint8_t* dst, int dstStride, int dstW, int dstH) {
  if (dst == nullptr || dstStride < dstW || dstW <= 0 || dstH <= 0) {
    return Status::Fail(kErrInvalidArgument, "YPlaneToGray8 dest");
  }
  const libyuv::RotationMode mode =
      ToLibyuvRotation(transform.rotationDegrees);
  const bool rotate = mode != libyuv::kRotate0;
  const bool mirror = transform.mirrorHorizontal;
  int rw = src.width;
  int rh = src.height;
  SwapIf90(transform.rotationDegrees, &rw, &rh);
  const bool scale = dstW != rw || dstH != rh;

  const uint8_t* cur = src.y.data;
  int curStride = src.y.stride;
  int curW = src.width;
  int curH = src.height;
  AlignedBuffer hold;

  if (rotate) {
    const bool last = !mirror && !scale;
    uint8_t* outp = last ? dst : nullptr;
    int os = last ? dstStride : AlignUp(rw);
    if (!last) {
      auto st = hold.Allocate(static_cast<size_t>(os) * static_cast<size_t>(rh));
      if (!st.ok) {
        return st;
      }
      outp = hold.data();
    }
    const int rc =
        libyuv::RotatePlane(cur, curStride, outp, os, src.width, src.height,
                            mode);
    if (rc != 0) {
      return Status::Fail(kErrDecodeFailed, "RotatePlane failed");
    }
    cur = outp;
    curStride = os;
    curW = rw;
    curH = rh;
  }
  if (mirror) {
    const bool last = !scale;
    AlignedBuffer next;
    uint8_t* outp = last ? dst : nullptr;
    int os = last ? dstStride : AlignUp(curW);
    if (!last) {
      auto st =
          next.Allocate(static_cast<size_t>(os) * static_cast<size_t>(curH));
      if (!st.ok) {
        return st;
      }
      outp = next.data();
    }
    const int rc =
        libyuv::I400Mirror(cur, curStride, outp, os, curW, curH);
    if (rc != 0) {
      return Status::Fail(kErrDecodeFailed, "I400Mirror failed");
    }
    if (!last) {
      hold = std::move(next);
    }
    cur = outp;
    curStride = os;
  }
  if (scale) {
    const int rc = libyuv::ScalePlane(cur, curStride, curW, curH, dst,
                                      dstStride, dstW, dstH, libyuv::kFilterBox);
    if (rc != 0) {
      return Status::Fail(kErrDecodeFailed, "ScalePlane failed");
    }
    return Status::Ok();
  }
  if (cur != dst) {
    libyuv::CopyPlane(cur, curStride, dst, dstStride, dstW, dstH);
  }
  return Status::Ok();
}

}  // namespace

const char* ColorConvert::MatrixName(ColorMatrix m) {
  switch (m) {
    case ColorMatrix::Bt709:
      return "bt709";
    case ColorMatrix::Bt2020:
      return "bt2020";
    case ColorMatrix::Bt601:
    default:
      return "bt601";
  }
}

ColorMatrix ColorConvert::DefaultMatrixForHeight(int height) {
  return InferColorMatrix(height, ColorMatrix::Bt601, false);
}

Status ColorConvert::Nv12ToRgb24(const Nv12View& src, PackedPlane* dst,
                                 ColorMatrix matrix, ColorRange range,
                                 bool packed) {
  auto st = NeedNv12(src, "Nv12ToRgb24");
  if (!st.ok) {
    return st;
  }
  if (dst == nullptr || dst->data == nullptr) {
    return Status::Fail(kErrInvalidArgument, "Nv12ToRgb24 dest");
  }
  dst->width = src.width;
  dst->height = src.height;
  const int minStride = src.width * 3;
  if (packed) {
    dst->stride = minStride;
  } else if (dst->stride < minStride) {
    dst->stride = AlignUp(minStride);
  }
  if (packed && dst->stride != minStride) {
    return Status::Fail(kErrInvalidArgument, "packed RGB stride");
  }
  const int rc = libyuv::NV21ToRGB24Matrix(
      src.y.data, src.y.stride, src.uv.data, src.uv.stride, dst->data,
      dst->stride, LibyuvVuConstants(matrix, range), src.width, src.height);
  if (rc != 0) {
    return Status::Fail(kErrDecodeFailed, "NV12ToRAW (RGB) matrix convert failed");
  }
  return Status::Ok();
}

Status ColorConvert::ScaleNv12(const Nv12View& src, MutableNv12* dst) {
  auto st = NeedNv12(src, "ScaleNv12");
  if (!st.ok) {
    return st;
  }
  if (dst == nullptr || dst->y.data == nullptr || dst->uv.data == nullptr ||
      dst->width <= 0 || dst->height <= 0) {
    return Status::Fail(kErrInvalidArgument, "ScaleNv12 dest");
  }
  const int rc = libyuv::NV12Scale(
      src.y.data, src.y.stride, src.uv.data, src.uv.stride, src.width,
      src.height, dst->y.data, dst->y.stride, dst->uv.data, dst->uv.stride,
      dst->width, dst->height, libyuv::kFilterBox);
  if (rc != 0) {
    return Status::Fail(kErrDecodeFailed, "NV12Scale failed");
  }
  return Status::Ok();
}

Status ColorConvert::RotateNv12(const Nv12View& src, MutableNv12* dst,
                                const VideoTransform& transform) {
  auto st = NeedNv12(src, "RotateNv12");
  if (!st.ok) {
    return st;
  }
  if (dst == nullptr || dst->y.data == nullptr || dst->uv.data == nullptr) {
    return Status::Fail(kErrInvalidArgument, "RotateNv12 dest");
  }
  int outW = src.width;
  int outH = src.height;
  SwapIf90(transform.rotationDegrees, &outW, &outH);
  dst->width = outW;
  dst->height = outH;

  const libyuv::RotationMode mode =
      ToLibyuvRotation(transform.rotationDegrees);
  const bool rotate = mode != libyuv::kRotate0;
  const bool mirror = transform.mirrorHorizontal;
  if (!rotate && !mirror) {
    const int rc = libyuv::NV12Copy(src.y.data, src.y.stride, src.uv.data,
                                    src.uv.stride, dst->y.data, dst->y.stride,
                                    dst->uv.data, dst->uv.stride, src.width,
                                    src.height);
    if (rc != 0) {
      return Status::Fail(kErrDecodeFailed, "NV12Copy failed");
    }
    return Status::Ok();
  }
  if (!rotate && mirror) {
    const int rc = libyuv::NV12Mirror(
        src.y.data, src.y.stride, src.uv.data, src.uv.stride, dst->y.data,
        dst->y.stride, dst->uv.data, dst->uv.stride, src.width, src.height);
    if (rc != 0) {
      return Status::Fail(kErrDecodeFailed, "NV12Mirror failed");
    }
    return Status::Ok();
  }

  const int oYStride = AlignUp(outW);
  const int oUStride = AlignUp((outW + 1) / 2);
  const int oYSize = oYStride * outH;
  const int oUSize = oUStride * ((outH + 1) / 2);
  std::vector<uint8_t> i420(static_cast<size_t>(oYSize + oUSize * 2));
  uint8_t* dy = i420.data();
  uint8_t* du = dy + oYSize;
  uint8_t* dv = du + oUSize;
  int rc = libyuv::NV12ToI420Rotate(
      src.y.data, src.y.stride, src.uv.data, src.uv.stride, dy, oYStride, du,
      oUStride, dv, oUStride, src.width, src.height, mode);
  if (rc != 0) {
    return Status::Fail(kErrDecodeFailed, "NV12ToI420Rotate failed");
  }
  if (mirror) {
    std::vector<uint8_t> mirrored(i420.size());
    uint8_t* my = mirrored.data();
    uint8_t* mu = my + oYSize;
    uint8_t* mv = mu + oUSize;
    rc = libyuv::I420Mirror(dy, oYStride, du, oUStride, dv, oUStride, my,
                            oYStride, mu, oUStride, mv, oUStride, outW, outH);
    if (rc != 0) {
      return Status::Fail(kErrDecodeFailed, "I420Mirror failed");
    }
    i420.swap(mirrored);
    dy = i420.data();
    du = dy + oYSize;
    dv = du + oUSize;
  }
  rc = libyuv::I420ToNV12(dy, oYStride, du, oUStride, dv, oUStride, dst->y.data,
                          dst->y.stride, dst->uv.data, dst->uv.stride, outW,
                          outH);
  if (rc != 0) {
    return Status::Fail(kErrDecodeFailed, "I420ToNV12 failed");
  }
  return Status::Ok();
}

Status ColorConvert::Nv12ToGray8(const Nv12View& src, PackedPlane* dst,
                                 const VideoTransform& transform, int maxSide,
                                 bool packed) {
  auto st = NeedNv12(src, "Nv12ToGray8");
  if (!st.ok) {
    return st;
  }
  if (dst == nullptr || dst->data == nullptr) {
    return Status::Fail(kErrInvalidArgument, "Nv12ToGray8 dest");
  }
  int rw = src.width;
  int rh = src.height;
  SwapIf90(transform.rotationDegrees, &rw, &rh);
  int fw = rw;
  int fh = rh;
  ScaleDim(rw, rh, maxSide, &fw, &fh);
  dst->width = fw;
  dst->height = fh;
  const int minStride = fw;
  if (packed) {
    dst->stride = minStride;
  } else if (dst->stride < minStride) {
    dst->stride = AlignUp(minStride);
  }
  return YPlaneToGray8(src, transform, dst->data, dst->stride, fw, fh);
}

Status ColorConvert::Convert(const Nv12View& src, VideoPixelFormat format,
                             const VideoTransform& transform, int maxSide,
                             bool packed, AlignedBuffer* storage,
                             VideoFrameView* out) {
  auto st = NeedNv12(src, "Convert");
  if (!st.ok) {
    return st;
  }
  if (storage == nullptr || out == nullptr) {
    return Status::Fail(kErrInvalidArgument, "Convert storage/out");
  }

  if (format == VideoPixelFormat::Gray8) {
    int rw = src.width;
    int rh = src.height;
    SwapIf90(transform.rotationDegrees, &rw, &rh);
    int fw = rw;
    int fh = rh;
    ScaleDim(rw, rh, maxSide, &fw, &fh);
    const int stride = packed ? fw : AlignUp(fw);
    st = storage->Allocate(static_cast<size_t>(stride) *
                           static_cast<size_t>(fh));
    if (!st.ok) {
      return st;
    }
    st = YPlaneToGray8(src, transform, storage->data(), stride, fw, fh);
    if (!st.ok) {
      return st;
    }
    *out = {};
    out->width = fw;
    out->height = fh;
    out->format = format;
    out->plane[0] = storage->data();
    out->stride[0] = stride;
    return Status::Ok();
  }

  Nv12View working = src;
  AlignedBuffer rotatedBuf;
  AlignedBuffer scaledBuf;
  MutableNv12 rotated{};
  MutableNv12 scaled{};

  const bool needRotate =
      (transform.rotationDegrees % 360) != 0 || transform.mirrorHorizontal;
  if (needRotate) {
    int rw = src.width;
    int rh = src.height;
    SwapIf90(transform.rotationDegrees, &rw, &rh);
    const int yStride = AlignUp(rw);
    const int uvStride = AlignUp(rw);
    const size_t yBytes = static_cast<size_t>(yStride) * static_cast<size_t>(rh);
    const size_t uvBytes =
        static_cast<size_t>(uvStride) * static_cast<size_t>((rh + 1) / 2);
    st = rotatedBuf.Allocate(yBytes + uvBytes);
    if (!st.ok) {
      return st;
    }
    rotated.y.data = rotatedBuf.data();
    rotated.y.stride = yStride;
    rotated.uv.data = rotatedBuf.data() + yBytes;
    rotated.uv.stride = uvStride;
    rotated.width = rw;
    rotated.height = rh;
    st = RotateNv12(src, &rotated, transform);
    if (!st.ok) {
      return st;
    }
    working.y.data = rotated.y.data;
    working.y.stride = rotated.y.stride;
    working.uv.data = rotated.uv.data;
    working.uv.stride = rotated.uv.stride;
    working.width = rotated.width;
    working.height = rotated.height;
  }

  int sw = working.width;
  int sh = working.height;
  bool didScale = false;
  if (ScaleDim(working.width, working.height, maxSide, &sw, &sh)) {
    didScale = true;
    const int yStride = AlignUp(sw);
    const int uvStride = AlignUp(sw);
    const size_t yBytes = static_cast<size_t>(yStride) * static_cast<size_t>(sh);
    const size_t uvBytes =
        static_cast<size_t>(uvStride) * static_cast<size_t>((sh + 1) / 2);
    st = scaledBuf.Allocate(yBytes + uvBytes);
    if (!st.ok) {
      return st;
    }
    scaled.y.data = scaledBuf.data();
    scaled.y.stride = yStride;
    scaled.uv.data = scaledBuf.data() + yBytes;
    scaled.uv.stride = uvStride;
    scaled.width = sw;
    scaled.height = sh;
    st = ScaleNv12(working, &scaled);
    if (!st.ok) {
      return st;
    }
    working.y.data = scaled.y.data;
    working.y.stride = scaled.y.stride;
    working.uv.data = scaled.uv.data;
    working.uv.stride = scaled.uv.stride;
    working.width = scaled.width;
    working.height = scaled.height;
  }

  *out = {};
  out->width = working.width;
  out->height = working.height;
  out->format = format;
  out->plane[0] = working.y.data;
  out->stride[0] = working.y.stride;

  if (format == VideoPixelFormat::Nv12) {
    out->plane[1] = working.uv.data;
    out->stride[1] = working.uv.stride;
    if (packed && working.y.stride != working.width) {
      const int yStride = working.width;
      const int uvStride = working.width;
      const size_t yBytes =
          static_cast<size_t>(yStride) * static_cast<size_t>(working.height);
      const size_t uvBytes =
          static_cast<size_t>(uvStride) * ((working.height + 1) / 2);
      st = storage->Allocate(yBytes + uvBytes);
      if (!st.ok) {
        return st;
      }
      libyuv::CopyPlane(working.y.data, working.y.stride, storage->data(),
                        yStride, working.width, working.height);
      libyuv::CopyPlane(working.uv.data, working.uv.stride,
                        storage->data() + yBytes, uvStride, working.width,
                        (working.height + 1) / 2);
      out->plane[0] = storage->data();
      out->stride[0] = yStride;
      out->plane[1] = storage->data() + yBytes;
      out->stride[1] = uvStride;
    } else if (needRotate || didScale) {
      const size_t yBytes = static_cast<size_t>(working.y.stride) *
                            static_cast<size_t>(working.height);
      *storage = didScale ? std::move(scaledBuf) : std::move(rotatedBuf);
      out->plane[0] = storage->data();
      out->plane[1] = storage->data() + yBytes;
    }
    return Status::Ok();
  }

  if (format == VideoPixelFormat::Rgb24) {
    const int stride = packed ? working.width * 3 : AlignUp(working.width * 3);
    st = storage->Allocate(static_cast<size_t>(stride) *
                           static_cast<size_t>(working.height));
    if (!st.ok) {
      return st;
    }
    PackedPlane rgb;
    rgb.data = storage->data();
    rgb.stride = stride;
    rgb.width = working.width;
    rgb.height = working.height;
    const ColorMatrix matrix = DefaultMatrixForHeight(working.height);
    st = Nv12ToRgb24(working, &rgb, matrix, ColorRange::Limited, packed);
    if (!st.ok) {
      return st;
    }
    out->plane[0] = storage->data();
    out->stride[0] = stride;
    return Status::Ok();
  }

  return Status::Fail(kErrInvalidArgument, "unknown pixel format");
}

}  // namespace video
}  // namespace sherpa_onnx
