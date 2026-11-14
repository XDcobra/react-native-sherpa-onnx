#include "DocEpub.h"

#include "DocHtmlText.h"
#include "DocPath.h"
#include "DocStructureBuild.h"
#include "DocUtf16.h"
#include "DocXml.h"
#include "decode/ImageDecoder.h"

#include "pugixml.hpp"

#include <algorithm>
#include <map>
#include <set>
#include <utility>

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
  std::string properties;
};

/** OPF data beyond manifest + spine (reader structure). */
struct PackageMeta {
  std::string toc_ncx_id;  // spine@toc (EPUB 2)
  std::string title;
  std::string creator;
  std::string language;
};

/** Collapsed text content of an XML node (whitespace runs → one space, trimmed). */
std::string CollapsedText(pugi::xml_node n) {
  std::string raw;
  if (!n) return raw;
  for (pugi::xpath_node xn : n.select_nodes(".//text()")) {
    raw += xn.node().value();
  }
  std::string out;
  for (char c : raw) {
    const bool ws = c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f';
    if (ws) {
      if (!out.empty() && out.back() != ' ') out.push_back(' ');
    } else {
      out.push_back(c);
    }
  }
  return TrimWs(out);
}

struct SpineItem {
  std::string idref;
  bool linear = true;
};

bool LoadPackage(ArchiveReader& ar, std::string* opf_path,
                 std::map<std::string, ManifestItem>* manifest,
                 std::vector<SpineItem>* spine, std::string* err_code,
                 std::string* err_message, PackageMeta* meta = nullptr) {
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
    mi.properties = XmlAttr(item, "properties");
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
  if (meta) {
    meta->toc_ncx_id = XmlAttr(sp, "toc");
    pugi::xml_node md = XmlSelect(pkg, "metadata");
    if (md) {
      meta->title = CollapsedText(XmlSelect(md, "title"));
      meta->creator = CollapsedText(XmlSelect(md, "creator"));
      meta->language = CollapsedText(XmlSelect(md, "language"));
    }
  }
  return true;
}

bool HasProperty(const std::string& props, const char* name) {
  size_t i = 0;
  const std::string want = name;
  while (i < props.size()) {
    while (i < props.size() && props[i] == ' ') ++i;
    size_t j = i;
    while (j < props.size() && props[j] != ' ') ++j;
    if (props.compare(i, j - i, want) == 0) return true;
    i = j;
  }
  return false;
}

/**
 * Section titles from the table of contents: EPUB 3 nav document
 * (nav[epub:type~=toc], else the first nav) or the EPUB 2 NCX. Keyed by archive
 * path without fragment; the first entry per file wins.
 */
std::map<std::string, std::string> LoadTocTitles(
    ArchiveReader& ar, const std::string& opf_dir,
    const std::map<std::string, ManifestItem>& manifest, const PackageMeta& meta) {
  std::map<std::string, std::string> titles;
  auto add = [&](const std::string& base_dir, const std::string& href,
                 const std::string& label) {
    if (label.empty()) return;
    const std::string path = JoinHref(base_dir, href);
    if (!path.empty() && titles.find(path) == titles.end()) titles[path] = label;
  };
  std::string err_code;
  std::string err_msg;
  for (const auto& kv : manifest) {
    if (!HasProperty(kv.second.properties, "nav")) continue;
    const std::string nav_path = JoinHref(opf_dir, kv.second.href);
    std::vector<uint8_t> bytes;
    if (!ar.ReadNamed(nav_path, &bytes, &err_code, &err_msg)) break;
    pugi::xml_document doc;
    if (LoadXml(bytes, &doc) != pugi::status_ok) break;
    pugi::xml_node toc_nav;
    for (pugi::xpath_node xn : doc.select_nodes("//*[local-name()='nav']")) {
      const std::string type = XmlAttr(xn.node(), "type");
      if (HasProperty(type, "toc")) {
        toc_nav = xn.node();
        break;
      }
      if (!toc_nav) toc_nav = xn.node();
    }
    if (toc_nav) {
      const std::string nav_dir = DirnameOf(nav_path);
      for (pugi::xpath_node xa : toc_nav.select_nodes(".//*[local-name()='a']")) {
        add(nav_dir, XmlAttr(xa.node(), "href"), CollapsedText(xa.node()));
      }
    }
    break;
  }
  if (!titles.empty()) return titles;
  auto ncx = manifest.find(meta.toc_ncx_id);
  if (ncx == manifest.end()) {
    for (auto it = manifest.begin(); it != manifest.end(); ++it) {
      if (it->second.media_type == "application/x-dtbncx+xml") {
        ncx = it;
        break;
      }
    }
  }
  if (ncx == manifest.end()) return titles;
  const std::string ncx_path = JoinHref(opf_dir, ncx->second.href);
  std::vector<uint8_t> bytes;
  if (!ar.ReadNamed(ncx_path, &bytes, &err_code, &err_msg)) return titles;
  pugi::xml_document doc;
  if (LoadXml(bytes, &doc) != pugi::status_ok) return titles;
  const std::string ncx_dir = DirnameOf(ncx_path);
  for (pugi::xpath_node xn : doc.select_nodes("//*[local-name()='navPoint']")) {
    pugi::xml_node label = XmlSelect(XmlChild(xn.node(), "navLabel"), "text");
    pugi::xml_node content = XmlChild(xn.node(), "content");
    add(ncx_dir, XmlAttr(content, "src"), CollapsedText(label));
  }
  return titles;
}

/** Appends one spine item through the shared structure builder. */
void AppendSection(ExtractTextResult* r, TxtStructure* st, const HtmlExtract* hx,
                   int section_index, const std::string& href, const std::string& kind,
                   const std::string& raw_image_href,
                   const std::map<std::string, std::string>& toc, int* utf16_off) {
  StructureSectionInput in;
  in.section_index = section_index;
  in.href = href;
  in.kind = kind;
  in.items = hx ? &hx->items : nullptr;
  in.raw_image_href = raw_image_href;
  auto t = toc.find(href);
  if (t != toc.end()) in.toc_title = t->second;
  AppendStructureSection(r, st, in, utf16_off);
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
#if !defined(SHERPA_ONNX_HAS_LEXBOR) || !SHERPA_ONNX_HAS_LEXBOR
  r.error_code = kErrLexborDisabled;
  r.error_message =
      "lexbor is not linked. Rebuild with sherpaOnnxEnableLexbor=true "
      "(Android) or SHERPA_ONNX_ENABLE_LEXBOR=1 (iOS).";
  return r;
#endif
  std::string opf_path;
  std::map<std::string, ManifestItem> manifest;
  std::vector<SpineItem> spine;
  PackageMeta meta;
  if (!LoadPackage(ar, &opf_path, &manifest, &spine, &err_code, &err_msg,
                   &meta)) {
    r.error_code = err_code.empty() ? kErrParseFailed : err_code;
    r.error_message = err_msg;
    return r;
  }
  const std::string opf_dir = DirnameOf(opf_path);
  DOC_LOGI("epub spine=%zu opf=%s", spine.size(), opf_path.c_str());
  const std::map<std::string, std::string> toc =
      LoadTocTitles(ar, opf_dir, manifest, meta);
  auto structure = std::make_shared<TxtStructure>();
  structure->title = meta.title;
  structure->creator = meta.creator;
  structure->language = meta.language;

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
      AppendSection(&r, structure.get(), nullptr, section_index, href, "image", href,
                    toc, &utf16);
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
    if (!hx.error_code.empty()) {
      r.error_code = hx.error_code;
      r.error_message = hx.error_message;
      return r;
    }
    if (HtmlIsImageOnly(hx)) {
      sec.kind = "image";
      r.sections.push_back(sec);
      r.image_only_sections.push_back(sec);
      AppendSection(&r, structure.get(), &hx, section_index, href, "image", "", toc,
                    &utf16);
      DOC_LOGI("image-only section=%d href=%s", section_index, href.c_str());
    } else {
      sec.kind = "text";
      r.sections.push_back(sec);
      AppendSection(&r, structure.get(), &hx, section_index, href, "text", "", toc,
                    &utf16);
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
  r.structure = std::move(structure);
  r.ok = true;
  return r;
}

namespace {

/**
 * Every image of the book in reading order (raw image spine items, images in
 * text and image-only sections), one entry per unique archive path; the
 * section is where the image first appears. Used with `all_images`.
 */
void CollectAllEpubImages(ArchiveReader& ar, const std::string& opf_dir,
                          const std::map<std::string, ManifestItem>& manifest,
                          const std::vector<SpineItem>& spine,
                          const ExtractOptions& opt,
                          std::vector<std::pair<std::string, int>>* out) {
  std::set<std::string> seen;
  auto add = [&](const std::string& path, int section) {
    if (!path.empty() && seen.insert(path).second) out->push_back({path, section});
  };
  std::string err_code;
  std::string err_msg;
  int section_index = 0;
  for (const SpineItem& si : spine) {
    if (Cancelled(opt)) return;
    if (!si.linear) continue;
    auto it = manifest.find(si.idref);
    if (it == manifest.end()) continue;
    const std::string href = JoinHref(opf_dir, it->second.href);
    if (LooksLikeImageType(it->second.media_type) || LooksLikeImageName(href)) {
      add(href, section_index++);
      continue;
    }
    std::vector<uint8_t> xhtml;
    if (ar.ReadNamed(href, &xhtml, &err_code, &err_msg)) {
      const HtmlExtract hx = ExtractHtmlText(xhtml.data(), xhtml.size());
      for (const HtmlBlock& item : hx.items) {
        if (item.kind == HtmlBlockKind::Image) {
          add(JoinHref(DirnameOf(href), item.image_src), section_index);
        }
      }
    }
    ++section_index;
  }
}

}  // namespace

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

  if (opt.all_images) {
    std::vector<std::pair<std::string, int>> images;
    CollectAllEpubImages(ar, opf_dir, manifest, spine, opt, &images);
    const int count = static_cast<int>(images.size());
    for (int i = 0; i < count; ++i) {
      if (Cancelled(opt)) {
        r.error_code = kErrCancelled;
        r.error_message = "cancelled";
        return r;
      }
      Progress(opt, i, count, "image");
      std::vector<uint8_t> bytes;
      if (!ar.ReadNamed(images[i].first, &bytes, &err_code, &err_msg)) {
        DOC_LOGI("decode skip missing image %s", images[i].first.c_str());
        continue;
      }
      auto decoded = sherpa_onnx::image::ImageDecoder::DecodeBytes(
          bytes.data(), bytes.size(), dec);
      if (!decoded.ok) {
        // e.g. SVG: the reader keeps the block, without a frame.
        DOC_LOGI("decode skip %s code=%s", images[i].first.c_str(),
                 decoded.errorCode.c_str());
        continue;
      }
      DocImageFrame fr;
      fr.rgb = std::move(decoded.frame);
      fr.section_index = images[i].second;
      fr.href = images[i].first;
      r.frames.push_back(std::move(fr));
    }
    Progress(opt, count, count, "done");
    if (r.frames.empty()) {
      r.error_code = kErrNoImages;
      r.error_message = "No decodable images";
      return r;
    }
    r.ok = true;
    return r;
  }

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
      if (!hx.error_code.empty()) {
        r.error_code = hx.error_code;
        r.error_message = hx.error_message;
        return r;
      }
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
