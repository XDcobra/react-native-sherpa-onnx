#pragma once

#include "DocTypes.h"
#include "DocUtf16.h"

#include <string>
#include <vector>

namespace sherpa_onnx {
namespace document {

struct HtmlExtract {
  std::string text;  // blocks joined with \n\n
  std::vector<std::string> blocks;  // one per block element
};

/** lexbor HTML5 parse → TTS text. Skips script/style/head/template/rt/rp. */
HtmlExtract ExtractHtmlText(const uint8_t* data, size_t size);

/** First img/src or svg image href in document order. Empty if none. */
std::string FirstImageHref(const uint8_t* data, size_t size);

inline bool HtmlIsImageOnly(const HtmlExtract& e) { return IsWsOnly(e.text); }

}  // namespace document
}  // namespace sherpa_onnx
