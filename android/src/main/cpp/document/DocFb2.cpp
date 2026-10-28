#include "DocFb2.h"

#include "DocBase64.h"
#include "DocHtmlText.h"
#include "DocPath.h"
#include "DocUtf16.h"
#include "DocXml.h"
#include "decode/ImageDecoder.h"

#include "pugixml.hpp"

#include <fstream>
#include <map>
#include <unistd.h>

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

bool ReadWholeFile(const DocumentSource& src, std::vector<uint8_t>* out,
                   std::string* err_code, std::string* err_message) {
  if (!out) return false;
  if (!src.path.empty()) {
    std::ifstream in(src.path, std::ios::binary);
    if (!in) {
      if (err_code) *err_code = kErrOpenFailed;
      if (err_message) *err_message = "Failed to open FB2 file";
      return false;
    }
    in.seekg(0, std::ios::end);
    const auto sz = in.tellg();
    if (sz < 0 || static_cast<int64_t>(sz) > kMaxEntryBytes) {
      if (err_code) *err_code = kErrOpenFailed;
      if (err_message) *err_message = "FB2 file exceeds 64 MiB";
      return false;
    }
    in.seekg(0);
    out->resize(static_cast<size_t>(sz));
    if (sz > 0) {
      in.read(reinterpret_cast<char*>(out->data()), sz);
    }
    return true;
  }
  if (src.fd >= 0) {
    if (::lseek(src.fd, 0, SEEK_END) < 0) {
      if (err_code) *err_code = kErrOpenFailed;
      if (err_message) *err_message = "Source is not seekable";
      return false;
    }
    const off_t sz = ::lseek(src.fd, 0, SEEK_CUR);
    if (sz < 0 || static_cast<int64_t>(sz) > kMaxEntryBytes) {
      if (err_code) *err_code = kErrOpenFailed;
      if (err_message) *err_message = "FB2 file exceeds 64 MiB";
      return false;
    }
    ::lseek(src.fd, 0, SEEK_SET);
    out->resize(static_cast<size_t>(sz));
    size_t off = 0;
    while (off < out->size()) {
      const ssize_t n =
          ::read(src.fd, out->data() + off, out->size() - off);
      if (n <= 0) break;
      off += static_cast<size_t>(n);
    }
    out->resize(off);
    return true;
  }
  if (err_code) *err_code = kErrInvalidArgument;
  if (err_message) *err_message = "FB2 source missing";
  return false;
}

bool LoadFb2Xml(const DocumentSource& src, ArchiveReader* zip,
                pugi::xml_document* doc, std::string* err_code,
                std::string* err_message) {
  std::vector<uint8_t> bytes;
  if (zip) {
    std::string fb2_name;
    for (const auto& e : zip->catalog()) {
      std::string lower = e.name;
      for (char& c : lower) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
      }
      if (lower.size() >= 4 && lower.compare(lower.size() - 4, 4, ".fb2") == 0) {
        fb2_name = e.name;
        break;
      }
    }
    if (fb2_name.empty()) {
      if (err_code) *err_code = kErrParseFailed;
      if (err_message) *err_message = "FB2 zip has no .fb2 entry";
      return false;
    }
    if (!zip->ReadNamed(fb2_name, &bytes, err_code, err_message)) return false;
  } else if (!ReadWholeFile(src, &bytes, err_code, err_message)) {
    return false;
  }
  const auto st =
      doc->load_buffer(bytes.data(), bytes.size(), pugi::parse_default,
                       pugi::encoding_auto);
  if (!st) {
    if (err_code) *err_code = kErrParseFailed;
    if (err_message) *err_message = "Failed to parse FB2 XML";
    return false;
  }
  return true;
}

void CollectSections(pugi::xml_node node, std::vector<pugi::xml_node>* out) {
  for (pugi::xml_node body : node.children()) {
    if (!XmlNameIs(body, "body")) continue;
    for (pugi::xml_node section : body.children()) {
      if (XmlNameIs(section, "section")) out->push_back(section);
    }
  }
}

std::string Fb2InnerText(pugi::xml_node node) {
  std::string acc;
  for (pugi::xml_node ch : node.children()) {
    if (ch.type() == pugi::node_pcdata || ch.type() == pugi::node_cdata) {
      acc += ch.value();
    } else {
      if (XmlNameIs(ch, "style") || XmlNameIs(ch, "binary")) continue;
      acc += Fb2InnerText(ch);
    }
  }
  return acc;
}

bool SectionHasText(pugi::xml_node section) {
  for (pugi::xml_node ch : section.children()) {
    if (XmlNameIs(ch, "section") || XmlNameIs(ch, "image") ||
        XmlNameIs(ch, "title")) {
      continue;
    }
    if (XmlNameIs(ch, "p") || XmlNameIs(ch, "poem") || XmlNameIs(ch, "cite") ||
        XmlNameIs(ch, "subtitle") || XmlNameIs(ch, "text-author") ||
        XmlNameIs(ch, "epigraph") || XmlNameIs(ch, "annotation") ||
        XmlNameIs(ch, "empty-line")) {
      if (XmlNameIs(ch, "empty-line")) continue;
      if (!IsWsOnly(Fb2InnerText(ch))) return true;
    }
  }
  return false;
}

std::string SectionImageHref(pugi::xml_node section) {
  pugi::xml_node img;
  for (pugi::xml_node ch : section.children()) {
    if (XmlNameIs(ch, "image")) {
      img = ch;
      break;
    }
  }
  if (!img) return {};
  std::string href = XmlAttr(img, "href");
  if (!href.empty() && href[0] == '#') href.erase(0, 1);
  return href;
}

void AppendFb2Blocks(ExtractTextResult* r, pugi::xml_node section, int idx,
                     const std::string& href, int* utf16) {
  auto flush = [&](const std::string& raw) {
    const std::string t = TrimWs(raw);
    if (t.empty()) return;
    if (*utf16 > 0) {
      r->text += "\n\n";
      *utf16 += 2;
    }
    const int start = *utf16;
    r->text += t;
    const int len = Utf16LengthOfUtf8(t);
    *utf16 += len;
    DocTextSpan span;
    span.utf16_start = start;
    span.utf16_end = start + len;
    span.level = "block";
    span.section_index = idx;
    span.href = href;
    r->spans.push_back(std::move(span));
  };
  for (pugi::xml_node ch : section.children()) {
    if (XmlNameIs(ch, "image")) continue;
    if (XmlNameIs(ch, "section")) {
      AppendFb2Blocks(r, ch, idx, href, utf16);
      continue;
    }
    const bool compound =
        XmlNameIs(ch, "title") || XmlNameIs(ch, "poem") || XmlNameIs(ch, "cite");
    if (XmlNameIs(ch, "p") || XmlNameIs(ch, "subtitle") ||
        XmlNameIs(ch, "text-author") || XmlNameIs(ch, "v") ||
        XmlNameIs(ch, "cite") || XmlNameIs(ch, "poem") ||
        XmlNameIs(ch, "title") || XmlNameIs(ch, "annotation")) {
      if (compound) {
        for (pugi::xml_node p : ch.children()) {
          if (XmlNameIs(p, "p") || XmlNameIs(p, "v")) flush(Fb2InnerText(p));
        }
      } else {
        flush(Fb2InnerText(ch));
      }
    }
  }
}

}  // namespace

ExtractTextResult ExtractFb2Text(const DocumentSource& src, ArchiveReader* zip,
                                 const ExtractOptions& opt) {
  ExtractTextResult r;
  r.format = "fb2";
  std::string err_code;
  std::string err_msg;
  Progress(opt, 0, 1, "open");
  pugi::xml_document doc;
  if (!LoadFb2Xml(src, zip, &doc, &err_code, &err_msg)) {
    r.error_code = err_code.empty() ? kErrParseFailed : err_code;
    r.error_message = err_msg;
    return r;
  }
  pugi::xml_node root = XmlSelect(doc, "FictionBook");
  if (!root) root = doc.document_element();
  std::vector<pugi::xml_node> sections;
  CollectSections(root, &sections);
  int utf16 = 0;
  const int total = static_cast<int>(sections.size());
  for (int i = 0; i < total; ++i) {
    if (Cancelled(opt)) {
      r.error_code = kErrCancelled;
      r.error_message = "cancelled";
      return r;
    }
    Progress(opt, i, total, "section");
    pugi::xml_node sec = sections[static_cast<size_t>(i)];
    const std::string id = XmlAttr(sec, "id");
    DocSection info;
    info.section_index = i;
    info.href = id;
    if (!SectionHasText(sec)) {
      info.kind = "image";
      r.sections.push_back(info);
      r.image_only_sections.push_back(info);
    } else {
      info.kind = "text";
      r.sections.push_back(info);
      AppendFb2Blocks(&r, sec, i, id, &utf16);
    }
  }
  Progress(opt, total, total, "done");
  if (r.text.empty()) {
    r.error_code = kErrNoText;
    r.error_message = "No extractable markup text";
    return r;
  }
  r.ok = true;
  return r;
}

ExtractImagesResult ExtractFb2Images(const DocumentSource& src, ArchiveReader* zip,
                                     const ExtractOptions& opt) {
  ExtractImagesResult r;
  r.format = "fb2";
  std::string err_code;
  std::string err_msg;
  Progress(opt, 0, 1, "open");
  pugi::xml_document doc;
  if (!LoadFb2Xml(src, zip, &doc, &err_code, &err_msg)) {
    r.error_code = err_code.empty() ? kErrParseFailed : err_code;
    r.error_message = err_msg;
    return r;
  }
  pugi::xml_node root = XmlSelect(doc, "FictionBook");
  if (!root) root = doc.document_element();
  std::vector<pugi::xml_node> sections;
  CollectSections(root, &sections);
  std::map<std::string, pugi::xml_node> binaries;
  for (pugi::xml_node b : root.children()) {
    if (!XmlNameIs(b, "binary")) continue;
    const std::string id = XmlAttr(b, "id");
    if (!id.empty()) binaries[id] = b;
  }
  sherpa_onnx::image::DecodeOptions dec;
  dec.maxSide = opt.max_side;
  const int total = static_cast<int>(sections.size());
  for (int i = 0; i < total; ++i) {
    if (Cancelled(opt)) {
      r.error_code = kErrCancelled;
      r.error_message = "cancelled";
      return r;
    }
    Progress(opt, i, total, "section");
    pugi::xml_node sec = sections[static_cast<size_t>(i)];
    if (SectionHasText(sec)) continue;
    const std::string href = SectionImageHref(sec);
    if (href.empty()) continue;
    auto it = binaries.find(href);
    if (it == binaries.end()) {
      DOC_LOGI("fb2 missing binary id=%s", href.c_str());
      continue;
    }
    std::vector<uint8_t> bytes;
    DecodeBase64(it->second.child_value(), &bytes);
    if (bytes.empty()) continue;
    auto decoded = sherpa_onnx::image::ImageDecoder::DecodeBytes(
        bytes.data(), bytes.size(), dec);
    if (!decoded.ok) {
      DOC_LOGI("fb2 decode skip %s %s", href.c_str(), decoded.errorCode.c_str());
      continue;
    }
    DocImageFrame fr;
    fr.rgb = std::move(decoded.frame);
    fr.section_index = i;
    fr.href = href;
    r.frames.push_back(std::move(fr));
  }
  Progress(opt, total, total, "done");
  if (r.frames.empty()) {
    r.error_code = kErrNoImages;
    r.error_message = "No image-only FB2 sections";
    return r;
  }
  r.ok = true;
  return r;
}

}  // namespace document
}  // namespace sherpa_onnx
