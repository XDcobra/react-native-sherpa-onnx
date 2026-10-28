#include "DocumentExtractor.h"

#include "DocArchive.h"
#include "DocComic.h"
#include "DocEpub.h"
#include "DocFb2.h"
#include "DocMobi.h"
#include "DocSniff.h"

#if defined(__ANDROID__)
#include <android/log.h>
#define DOC_LOGI(...) \
  __android_log_print(ANDROID_LOG_INFO, "SherpaOnnx:doc", __VA_ARGS__)
#else
#define DOC_LOGI(...) \
  do {                \
  } while (0)
#endif

namespace sherpa_onnx {
namespace document {

namespace {

ExtractTextResult Fail(const char* code, const std::string& msg) {
  ExtractTextResult r;
  r.error_code = code;
  r.error_message = msg;
  return r;
}

ExtractImagesResult FailImg(const char* code, const std::string& msg) {
  ExtractImagesResult r;
  r.error_code = code;
  r.error_message = msg;
  return r;
}

#ifndef HAVE_LIBARCHIVE
const char* kDisabledMsg =
    "libarchive is not linked. Rebuild without sherpaOnnxDisableLibarchive "
    "/ SHERPA_ONNX_DISABLE_LIBARCHIVE.";
#endif

}  // namespace

ExtractTextResult ExtractDocumentText(const DocumentSource& src,
                                      const ExtractOptions& opt) {
#ifndef HAVE_LIBARCHIVE
  (void)src;
  (void)opt;
  return Fail(kErrArchiveDisabled, kDisabledMsg);
#else
  if (src.path.empty() && src.fd < 0) {
    return Fail(kErrInvalidArgument, "source must be a path or seekable fd");
  }
  Progress(opt, 0, 1, "open");
  std::string err_code;
  std::string err_msg;
  ArchiveReader ar;
  bool have_ar = false;
  uint8_t prefix[8];
  size_t got = 0;
  if (!ReadSourcePrefix(src, prefix, sizeof(prefix), &got, &err_code, &err_msg)) {
    return Fail(err_code.c_str(), err_msg);
  }
  const bool zip_or_rar =
      (got >= 4 && prefix[0] == 0x50 && prefix[1] == 0x4B) ||
      (got >= 6 && prefix[0] == 'R' && prefix[1] == 'a' && prefix[2] == 'r');
  if (zip_or_rar) {
    if (!ArchiveReader::Open(src, &ar, &err_code, &err_msg)) {
      return Fail(err_code.empty() ? kErrOpenFailed : err_code.c_str(), err_msg);
    }
    have_ar = true;
  }
  const DocFormat fmt =
      SniffFormat(src, have_ar ? &ar : nullptr, &err_code, &err_msg);
  DOC_LOGI("extractText format=%s", FormatName(fmt));
  if (fmt == DocFormat::Unknown) {
    return Fail(err_code.empty() ? kErrUnsupportedFormat : err_code.c_str(),
                err_msg.empty() ? "Unrecognized document container" : err_msg);
  }
  if (fmt == DocFormat::Pdf) {
    return Fail(kErrUnsupportedFormat, "PDF is not handled by document/; use pdf/");
  }
  if (fmt == DocFormat::Mobi) {
    return ExtractMobiText(src, opt);
  }
  if (fmt == DocFormat::Cbz || fmt == DocFormat::Cbr) {
    return Fail(kErrNoText, "Comic archives have no markup text");
  }
  if (fmt == DocFormat::Epub) {
    if (!have_ar) {
      return Fail(kErrOpenFailed, "EPUB requires a seekable ZIP archive");
    }
    return ExtractEpubText(ar, opt);
  }
  if (fmt == DocFormat::Fb2) {
    return ExtractFb2Text(src, have_ar ? &ar : nullptr, opt);
  }
  return Fail(kErrUnsupportedFormat, "Unrecognized document container");
#endif
}

ExtractImagesResult ExtractDocumentImages(const DocumentSource& src,
                                          const ExtractOptions& opt) {
#ifndef HAVE_LIBARCHIVE
  (void)src;
  (void)opt;
  return FailImg(kErrArchiveDisabled, kDisabledMsg);
#else
  if (src.path.empty() && src.fd < 0) {
    return FailImg(kErrInvalidArgument, "source must be a path or seekable fd");
  }
  Progress(opt, 0, 1, "open");
  std::string err_code;
  std::string err_msg;
  ArchiveReader ar;
  bool have_ar = false;
  uint8_t prefix[8];
  size_t got = 0;
  if (!ReadSourcePrefix(src, prefix, sizeof(prefix), &got, &err_code, &err_msg)) {
    return FailImg(err_code.c_str(), err_msg);
  }
  const bool zip_or_rar =
      (got >= 4 && prefix[0] == 0x50 && prefix[1] == 0x4B) ||
      (got >= 6 && prefix[0] == 'R' && prefix[1] == 'a' && prefix[2] == 'r');
  if (zip_or_rar) {
    if (!ArchiveReader::Open(src, &ar, &err_code, &err_msg)) {
      return FailImg(err_code.empty() ? kErrOpenFailed : err_code.c_str(),
                     err_msg);
    }
    have_ar = true;
  }
  const DocFormat fmt =
      SniffFormat(src, have_ar ? &ar : nullptr, &err_code, &err_msg);
  DOC_LOGI("extractImages format=%s", FormatName(fmt));
  if (fmt == DocFormat::Unknown) {
    return FailImg(err_code.empty() ? kErrUnsupportedFormat : err_code.c_str(),
                   err_msg.empty() ? "Unrecognized document container" : err_msg);
  }
  if (fmt == DocFormat::Pdf) {
    return FailImg(kErrUnsupportedFormat,
                   "PDF is not handled by document/; use pdf/");
  }
  if (fmt == DocFormat::Mobi) {
    return ExtractMobiImages(src, opt);
  }
  if (fmt == DocFormat::Cbz || fmt == DocFormat::Cbr) {
    if (!have_ar) {
      return FailImg(kErrOpenFailed, "Comic archive is not seekable");
    }
    return ExtractComicImages(ar, FormatName(fmt), opt);
  }
  if (fmt == DocFormat::Epub) {
    if (!have_ar) {
      return FailImg(kErrOpenFailed, "EPUB requires a seekable ZIP archive");
    }
    return ExtractEpubImages(ar, opt);
  }
  if (fmt == DocFormat::Fb2) {
    return ExtractFb2Images(src, have_ar ? &ar : nullptr, opt);
  }
  return FailImg(kErrUnsupportedFormat, "Unrecognized document container");
#endif
}

}  // namespace document
}  // namespace sherpa_onnx
