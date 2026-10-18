#pragma once

namespace sherpa_onnx {
namespace pdf {

/** True when this binary was built with PDFium linked (`HAVE_PDFIUM`). */
inline bool IsPdfiumCompiledIn() {
#if defined(HAVE_PDFIUM) && HAVE_PDFIUM
  return true;
#else
  return false;
#endif
}

}  // namespace pdf
}  // namespace sherpa_onnx
