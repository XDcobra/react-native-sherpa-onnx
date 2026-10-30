#include "DocEpub.h"

#include "DocHtmlText.h"
#include "DocPath.h"
#include "DocUtf16.h"
#include "DocXml.h"
#include "decode/ImageDecoder.h"

#include "pugixml.hpp"

#include <algorithm>
#include <map>

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

pugi::xml_parse_status LoadXml(const std::vector<uint8_t>& bytes,
                               pugi::xml_document* doc) {
  if (!doc || bytes.empty()) return pugi::status_internal_error;
  return doc
      ->load_buffer(bytes.data(), bytes.size(),
                    pugi::parse_default | pugi::parse_fragment,
                    pugi::encoding_auto)
      .status;
}

bool LooksLikeImageType(const std::string& media) {
  return media.rfind("image/", 0) == 0;
}

bool CheckEncryption(ArchiveReader& ar, std::string* err_code,
                     std::string* err_message) {
  if (!ar.HasEntry("META-INF/encryption.xml")) return true;
  std::vector<uint8_t> bytes;
  if (!ar.ReadNamed("META-INF/encryption.xml", &bytes, err_code, err_message)) {
    return false;
  }
  pugi::xml_document doc;
  if (LoadXml(bytes, &doc) != pugi::status_ok) {
    if (err_code) *err_code = kErrParseFailed;
    if (err_message) *err_message = "Failed to parse encryption.xml";
    return false;
  }
  for (pugi::xpath_node xn :
       doc.select_nodes("//*[local-name()='EncryptedData']")) {
    pugi::xml_node n = xn.node();
    std::string uri;
    pugi::xml_node cipher =
        XmlSelect(XmlSelect(n, "CipherData"), "CipherReference");
    if (!cipher) cipher = XmlSelect(n, "CipherReference");
    if (cipher) uri = XmlAttr(cipher, "URI");
    pugi::xml_node method = XmlSelect(n, "EncryptionMethod");
    const std::string algo = XmlAttr(method, "Algorithm");
    const bool font_algo =
        algo.find("idpf.org/2008/embedding") != std::string::npos ||
        algo.find("adobe.com/pdf/enc") != std::string::npos;
    if (!uri.empty() && LooksLikeFont(uri) && font_algo) {
      continue;
    }
    if (!uri.empty() && LooksLikeFont(uri) && algo.empty()) {
      continue;
    }
    if (font_algo && uri.empty()) {
      continue;
    }
    if (!uri.empty() && LooksLikeFont(uri)) {
      continue;
    }
    if (err_code) *err_code = kErrDrm;
    if (err_message) {
      *err_message = "Encrypted EPUB content (DRM)";
    }
    DOC_LOGI("skip drm uri=%s algo=%s", uri.c_str(), algo.c_str());
    return false;
  }
  return true;
}

struct ManifestItem {
  std::string href;
  std::string media_type;
};

struct SpineItem {
  std::string idref;
  bool linear = true;
};

bool LoadPackage(ArchiveReader& ar, std::string* opf_path,
                 std::map<std::string, ManifestItem>* manifest,
                 std::vector<SpineItem>* spine, std::string* err_code,
                 std::string* err_message) {
  std::vector<uint8_t> container;
  if (!ar.ReadNamed("META-INF/container.xml", &container, err_code,
                    err_message)) {
    return false;
  }
  pugi::xml_document cdoc;
  if (LoadXml(container, &cdoc) != pugi::status_ok) {
    if (err_code) *err_code = kErrParseFailed;
    if (err_message) *err_message = "Failed to parse container.xml";
    return false;
  }
  pugi::xml_node rootfile = XmlSelect(cdoc, "rootfile");
  std::string full = XmlAttr(rootfile, "full-path");
  if (full.empty()) {
    pugi::xpath_node xn = cdoc.select_node("//*[@full-path]");
    if (xn) full = XmlAttr(xn.node(), "full-path");
  }
  if (full.empty()) {
    if (err_code) *err_code = kErrParseFailed;
    if (err_message) *err_message = "EPUB container.xml missing rootfile";
    return false;
  }
  full = NormalizeArchivePath(full);
  if (opf_path) *opf_path = full;

  std::vector<uint8_t> opf;
  if (!ar.ReadNamed(full, &opf, err_code, err_message)) return false;
  pugi::xml_document pdoc;
  if (LoadXml(opf, &pdoc) != pugi::status_ok) {
    if (err_code) *err_code = kErrParseFailed;
    if (err_message) *err_message = "Failed to parse OPF";
    return false;
  }
  pugi::xml_node pkg = XmlSelect(pdoc, "package");
  if (!pkg) pkg = pdoc.document_element();
  pugi::xml_node man = XmlSelect(pkg, "manifest");
  pugi::xml_node sp = XmlSelect(pkg, "spine");
  if (!man || !sp) {
    if (err_code) *err_code = kErrParseFailed;
    if (err_message) *err_message = "OPF missing manifest or spine";
    return false;
  }
  for (pugi::xml_node item : man.children()) {
    if (!XmlNameIs(item, "item")) continue;
    ManifestItem mi;
    mi.href = XmlAttr(item, "href");
    mi.media_type = XmlAttr(item, "media-type");
    const std::string id = XmlAttr(item, "id");
    if (!id.empty()) (*manifest)[id] = std::move(mi);
  }
  for (pugi::xml_node iref : sp.children()) {
    if (!XmlNameIs(iref, "itemref")) continue;
    SpineItem si;
    si.idref = XmlAttr(iref, "idref");
    const std::string lin = XmlAttr(iref, "linear");
    si.linear = !(lin == "no" || lin == "NO");
    if (!si.idref.empty()) spine->push_back(std::move(si));
  }
  return true;
}

void AppendBlocks(ExtractTextResult* r, const HtmlExtract& hx, int section_index,
                  const std::string& href, int* utf16_off) {
  for (const auto& block : hx.blocks) {
    if (*utf16_off > 0) {
      r->text += "\n\n";
      *utf16_off += 2;
    }
    const int start = *utf16_off;
    r->text += block;
    const int len = Utf16LengthOfUtf8(block);
    *utf16_off += len;
    DocTextSpan span;
    span.utf16_start = start;
    span.utf16_end = start + len;
    span.level = "block";
    span.section_index = section_index;
    span.href = href;
    r->spans.push_back(std::move(span));
  }
}

}  // namespace

ExtractTextResult ExtractEpubText(ArchiveReader& ar, const ExtractOptions& opt) {
  ExtractTextResult r;
  r.format = "epub";
  std::string err_code;
  std::string err_msg;
  Progress(opt, 0, 1, "open");
  if (!CheckEncryption(ar, &err_code, &err_msg)) {
    r.error_code = err_code.empty() ? kErrDrm : err_code;
    r.error_message = err_msg;
    return r;
  }
  std::string opf_path;
  std::map<std::string, ManifestItem> manifest;
  std::vector<SpineItem> spine;
  if (!LoadPackage(ar, &opf_path, &manifest, &spine, &err_code, &err_msg)) {
    r.error_code = err_code.empty() ? kErrParseFailed : err_code;
    r.error_message = err_msg;
    return r;
  }
  const std::string opf_dir = DirnameOf(opf_path);
  DOC_LOGI("epub spine=%zu opf=%s", spine.size(), opf_path.c_str());

  int utf16 = 0;
  int section_index = 0;
  const int total = static_cast<int>(spine.size());
  for (size_t i = 0; i < spine.size(); ++i) {
    if (Cancelled(opt)) {
      r.error_code = kErrCancelled;
      r.error_message = "cancelled";
      return r;
    }
    Progress(opt, static_cast<int>(i), total, "section");
    const SpineItem& si = spine[i];
    if (!si.linear) {
      DOC_LOGI("skip linear=no idref=%s", si.idref.c_str());
      continue;
    }
    auto it = manifest.find(si.idref);
    if (it == manifest.end()) {
      r.error_code = kErrParseFailed;
      r.error_message = "Spine idref missing from manifest: " + si.idref;
      return r;
    }
    const std::string href = JoinHref(opf_dir, it->second.href);
    DocSection sec;
    sec.section_index = section_index;
    sec.href = href;

    if (LooksLikeImageType(it->second.media_type) ||
        LooksLikeImageName(href)) {
      sec.kind = "image";
      r.sections.push_back(sec);
      r.image_only_sections.push_back(sec);
      ++section_index;
      continue;
    }

    std::vector<uint8_t> xhtml;
    if (!ar.ReadNamed(href, &xhtml, &err_code, &err_msg)) {
      r.error_code = err_code.empty() ? kErrParseFailed : err_code;
      r.error_message = err_msg;
      return r;
    }
    const HtmlExtract hx = ExtractHtmlText(xhtml.data(), xhtml.size());
    if (HtmlIsImageOnly(hx)) {
      sec.kind = "image";
      r.sections.push_back(sec);
      r.image_only_sections.push_back(sec);
      DOC_LOGI("image-only section=%d href=%s", section_index, href.c_str());
    } else {
      sec.kind = "text";
      r.sections.push_back(sec);
      AppendBlocks(&r, hx, section_index, href, &utf16);
    }
    ++section_index;
  }
  Progress(opt, total, total, "done");
  if (r.sections.empty() || (r.text.empty() && r.image_only_sections.size() == r.sections.size())) {
    if (r.text.empty()) {
      r.error_code = kErrNoText;
      r.error_message = "No extractable markup text";
      r.ok = false;
      return r;
    }
  }
  r.ok = true;
  return r;
}

ExtractImagesResult ExtractEpubImages(ArchiveReader& ar,
                                      const ExtractOptions& opt) {
  ExtractImagesResult r;
  r.format = "epub";
  std::string err_code;
  std::string err_msg;
  Progress(opt, 0, 1, "open");
  if (!CheckEncryption(ar, &err_code, &err_msg)) {
    r.error_code = err_code.empty() ? kErrDrm : err_code;
    r.error_message = err_msg;
    return r;
  }
  std::string opf_path;
  std::map<std::string, ManifestItem> manifest;
  std::vector<SpineItem> spine;
  if (!LoadPackage(ar, &opf_path, &manifest, &spine, &err_code, &err_msg)) {
    r.error_code = err_code.empty() ? kErrParseFailed : err_code;
    r.error_message = err_msg;
    return r;
  }
  const std::string opf_dir = DirnameOf(opf_path);
  const int total = static_cast<int>(spine.size());
  int section_index = 0;
  sherpa_onnx::image::DecodeOptions dec;
  dec.maxSide = opt.max_side;

  for (size_t i = 0; i < spine.size(); ++i) {
    if (Cancelled(opt)) {
      r.error_code = kErrCancelled;
      r.error_message = "cancelled";
      return r;
    }
    Progress(opt, static_cast<int>(i), total, "section");
    const SpineItem& si = spine[i];
    if (!si.linear) continue;
    auto it = manifest.find(si.idref);
    if (it == manifest.end()) continue;
    const std::string href = JoinHref(opf_dir, it->second.href);
    const bool media_image = LooksLikeImageType(it->second.media_type) ||
                             LooksLikeImageName(href);
    std::string image_path;
    if (media_image) {
      image_path = href;
    } else {
      std::vector<uint8_t> xhtml;
      if (!ar.ReadNamed(href, &xhtml, &err_code, &err_msg)) {
        continue;
      }
      const HtmlExtract hx = ExtractHtmlText(xhtml.data(), xhtml.size());
      if (!HtmlIsImageOnly(hx)) {
        ++section_index;
        continue;
      }
      const std::string img_href = FirstImageHref(xhtml.data(), xhtml.size());
      if (img_href.empty()) {
        DOC_LOGI("image-only xhtml has no img href=%s", href.c_str());
        ++section_index;
        continue;
      }
      image_path = JoinHref(DirnameOf(href), img_href);
    }
    std::vector<uint8_t> bytes;
    if (!ar.ReadNamed(image_path, &bytes, &err_code, &err_msg)) {
      DOC_LOGI("decode skip missing image %s", image_path.c_str());
      ++section_index;
      continue;
    }
    auto decoded = sherpa_onnx::image::ImageDecoder::DecodeBytes(
        bytes.data(), bytes.size(), dec);
    if (!decoded.ok) {
      DOC_LOGI("decode skip %s code=%s", image_path.c_str(),
               decoded.errorCode.c_str());
      ++section_index;
      continue;
    }
    DocImageFrame fr;
    fr.rgb = std::move(decoded.frame);
    fr.section_index = section_index;
    fr.href = image_path;
    r.frames.push_back(std::move(fr));
    ++section_index;
  }
  Progress(opt, total, total, "done");
  if (r.frames.empty()) {
    r.error_code = kErrNoImages;
    r.error_message = "No image-only sections";
    return r;
  }
  r.ok = true;
  return r;
}

}  // namespace document
}  // namespace sherpa_onnx
