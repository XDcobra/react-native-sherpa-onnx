#include "DocFb2.h"

#include "DocBase64.h"
#include "DocHtmlText.h"
#include "DocPath.h"
#include "DocStructureBuild.h"
#include "DocUtf16.h"
#include "DocXml.h"
#include "decode/ImageDecoder.h"

#include "pugixml.hpp"

#include <fstream>
#include <algorithm>
#include <map>
#include <set>
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

/**
 * One reader section of an FB2 book: a top-level <section> of a <body>, or the
 * body's own lead-in (title, epigraph, image before the first section).
 */
struct Fb2Section {
  pugi::xml_node node;
  bool intro = false;  // body lead-in: walk everything except <section>
  bool notes = false;  // <body name="notes|comments">: not part of the contents
  std::string href;
};

std::vector<Fb2Section> CollectSections(pugi::xml_node root) {
  std::vector<Fb2Section> out;
  int body_index = 0;
  for (pugi::xml_node body : root.children()) {
    if (!XmlNameIs(body, "body")) continue;
    const std::string name = XmlAttr(body, "name");
    const bool notes = name == "notes" || name == "comments";
    bool has_intro = false;
    for (pugi::xml_node ch : body.children()) {
      if (XmlNameIs(ch, "title") || XmlNameIs(ch, "epigraph") || XmlNameIs(ch, "image")) {
        has_intro = true;
      }
    }
    if (has_intro) out.push_back({body, true, notes, "body-" + std::to_string(body_index)});
    for (pugi::xml_node section : body.children()) {
      if (XmlNameIs(section, "section")) {
        out.push_back({section, false, notes, XmlAttr(section, "id")});
      }
    }
    ++body_index;
  }
  return out;
}

/** Inner text; inline <style> / <emphasis> / <a> keep their text, <image> and <binary> none. */
std::string Fb2InnerText(pugi::xml_node node) {
  std::string acc;
  for (pugi::xml_node ch : node.children()) {
    if (ch.type() == pugi::node_pcdata || ch.type() == pugi::node_cdata) {
      acc += ch.value();
    } else {
      if (XmlNameIs(ch, "image") || XmlNameIs(ch, "binary")) continue;
      acc += Fb2InnerText(ch);
    }
  }
  return acc;
}

/** Whitespace runs → one space, trimmed (reader structure rule). */
std::string Collapse(const std::string& raw) {
  std::string out;
  out.reserve(raw.size());
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

HtmlBlock Fb2Image(pugi::xml_node img) {
  HtmlBlock b;
  b.kind = HtmlBlockKind::Image;
  b.image_src = XmlAttr(img, "href");
  const pugi::xml_attribute alt = img.attribute("alt");
  if (alt) {
    b.has_alt = true;
    b.alt = Collapse(alt.value());
  }
  return b;
}

void PushText(std::vector<HtmlBlock>* items, HtmlBlockKind kind, int level,
              const std::string& text) {
  if (text.empty()) return;
  HtmlBlock b;
  b.kind = kind;
  b.level = kind == HtmlBlockKind::Heading ? std::max(1, std::min(6, level)) : 0;
  b.text = text;
  items->push_back(std::move(b));
}

/** A paragraph-like element plus the inline images it holds (after it). */
void PushParagraph(std::vector<HtmlBlock>* items, pugi::xml_node p) {
  PushText(items, HtmlBlockKind::Paragraph, 0, Collapse(Fb2InnerText(p)));
  for (pugi::xpath_node img : p.select_nodes(".//*[local-name()='image']")) {
    items->push_back(Fb2Image(img.node()));
  }
}

/** Lines of a <title> / stanza title (<p> children, else its own text) joined by "\n". */
std::string TitleText(pugi::xml_node title) {
  std::string out;
  bool any_p = false;
  for (pugi::xml_node p : title.children()) {
    if (!XmlNameIs(p, "p")) continue;
    any_p = true;
    const std::string line = Collapse(Fb2InnerText(p));
    if (line.empty()) continue;
    if (!out.empty()) out += "\n";
    out += line;
  }
  return any_p ? out : Collapse(Fb2InnerText(title));
}

void WalkFb2(pugi::xml_node container, int depth, bool intro, std::vector<HtmlBlock>* items);

void WalkPoem(pugi::xml_node poem, int depth, std::vector<HtmlBlock>* items) {
  for (pugi::xml_node ch : poem.children()) {
    if (XmlNameIs(ch, "title")) {
      PushText(items, HtmlBlockKind::Heading, depth + 1, TitleText(ch));
    } else if (XmlNameIs(ch, "epigraph")) {
      WalkFb2(ch, depth, false, items);
    } else if (XmlNameIs(ch, "stanza")) {
      std::string lines;
      for (pugi::xml_node v : ch.children()) {
        if (XmlNameIs(v, "title") || XmlNameIs(v, "subtitle")) {
          PushText(items, HtmlBlockKind::Heading, depth + 2, TitleText(v));
        } else if (XmlNameIs(v, "v")) {
          const std::string line = Collapse(Fb2InnerText(v));
          if (line.empty()) continue;
          if (!lines.empty()) lines += "\n";
          lines += line;
        }
      }
      PushText(items, HtmlBlockKind::Paragraph, 0, lines);
    } else if (XmlNameIs(ch, "v") || XmlNameIs(ch, "text-author") || XmlNameIs(ch, "date")) {
      // <v> directly in a poem (no stanza): one line per paragraph.
      PushParagraph(items, ch);
    }
  }
}

/**
 * FB2 elements → reader blocks: <title> → heading (level = section depth,
 * lines joined by "\n"), <subtitle> → heading one level deeper, <p> /
 * <text-author> → paragraph, <stanza> → one paragraph with "\n" between
 * lines, <empty-line> → separator, <image> → image, table cells →
 * paragraphs. Nested sections stay in the same reader section, one heading
 * level deeper.
 */
void WalkFb2(pugi::xml_node container, int depth, bool intro, std::vector<HtmlBlock>* items) {
  for (pugi::xml_node ch : container.children()) {
    if (XmlNameIs(ch, "section")) {
      if (!intro) WalkFb2(ch, depth + 1, false, items);
    } else if (XmlNameIs(ch, "title")) {
      const size_t before = items->size();
      PushText(items, HtmlBlockKind::Heading, depth, TitleText(ch));
      // Section titles are the book's contents (not the body's own title).
      if (!intro && items->size() > before) items->back().toc_level = std::max(1, std::min(6, depth));
    } else if (XmlNameIs(ch, "subtitle")) {
      PushText(items, HtmlBlockKind::Heading, depth + 1, Collapse(Fb2InnerText(ch)));
    } else if (XmlNameIs(ch, "p") || XmlNameIs(ch, "text-author") || XmlNameIs(ch, "date")) {
      PushParagraph(items, ch);
    } else if (XmlNameIs(ch, "empty-line")) {
      // A scene break; never leading or doubled.
      if (!items->empty() && items->back().kind != HtmlBlockKind::Separator) {
        HtmlBlock b;
        b.kind = HtmlBlockKind::Separator;
        items->push_back(std::move(b));
      }
    } else if (XmlNameIs(ch, "image")) {
      items->push_back(Fb2Image(ch));
    } else if (XmlNameIs(ch, "poem")) {
      WalkPoem(ch, depth, items);
    } else if (XmlNameIs(ch, "epigraph") || XmlNameIs(ch, "cite") ||
               XmlNameIs(ch, "annotation")) {
      WalkFb2(ch, depth, false, items);
    } else if (XmlNameIs(ch, "table")) {
      for (pugi::xpath_node cell : ch.select_nodes(".//*[local-name()='td' or local-name()='th']")) {
        PushParagraph(items, cell.node());
      }
    }
  }
  // Drop a trailing separator.
  if (!items->empty() && items->back().kind == HtmlBlockKind::Separator) items->pop_back();
}

std::vector<HtmlBlock> SectionItems(const Fb2Section& sec) {
  std::vector<HtmlBlock> items;
  WalkFb2(sec.node, 1, sec.intro, &items);
  if (sec.notes) {
    for (auto& b : items) b.toc_level = 0;
  }
  return items;
}

bool HasText(const std::vector<HtmlBlock>& items) {
  for (const auto& b : items) {
    if (b.kind == HtmlBlockKind::Paragraph || b.kind == HtmlBlockKind::Heading) return true;
  }
  return false;
}

/** "#id" → "id": the <binary> id, which is also the image frame href. */
std::string Fb2ImageHref(const std::string& src) {
  if (src.empty()) return {};
  return src[0] == '#' ? src.substr(1) : std::string();  // external links: none
}

std::string PersonName(pugi::xml_node author) {
  std::string out;
  for (const char* part : {"first-name", "middle-name", "last-name"}) {
    const std::string v = Collapse(Fb2InnerText(XmlChild(author, part)));
    if (v.empty()) continue;
    if (!out.empty()) out += ' ';
    out += v;
  }
  if (out.empty()) out = Collapse(Fb2InnerText(XmlChild(author, "nickname")));
  return out;
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

  auto structure = std::make_shared<TxtStructure>();
  structure->format = "fb2";
  structure->version = 1;
  pugi::xml_node info = XmlChild(XmlChild(root, "description"), "title-info");
  structure->title = Collapse(Fb2InnerText(XmlChild(info, "book-title")));
  structure->creator = PersonName(XmlChild(info, "author"));
  structure->language = Collapse(Fb2InnerText(XmlChild(info, "lang")));

  const std::vector<Fb2Section> sections = CollectSections(root);
  int utf16 = 0;
  const int total = static_cast<int>(sections.size());
  for (int i = 0; i < total; ++i) {
    if (Cancelled(opt)) {
      r.error_code = kErrCancelled;
      r.error_message = "cancelled";
      return r;
    }
    Progress(opt, i, total, "section");
    const Fb2Section& sec = sections[static_cast<size_t>(i)];
    const std::vector<HtmlBlock> items = SectionItems(sec);
    DocSection doc_sec;
    doc_sec.section_index = i;
    doc_sec.href = sec.href;
    doc_sec.kind = HasText(items) ? "text" : "image";
    r.sections.push_back(doc_sec);
    if (doc_sec.kind == "image") r.image_only_sections.push_back(doc_sec);

    StructureSectionInput in;
    in.section_index = i;
    in.href = sec.href;
    in.kind = doc_sec.kind;
    in.items = &items;
    in.resolve_image = Fb2ImageHref;
    // FB2 titles are the book's contents.
    pugi::xml_node title = XmlChild(sec.node, "title");
    if (title) {
      std::string t = TitleText(title);
      std::replace(t.begin(), t.end(), '\n', ' ');
      in.toc_title = t;
    }
    AppendStructureSection(&r, structure.get(), in, &utf16);
  }
  Progress(opt, total, total, "done");
  if (r.text.empty()) {
    r.error_code = kErrNoText;
    r.error_message = "No extractable markup text";
    return r;
  }
  r.structure = std::move(structure);
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
  const std::vector<Fb2Section> sections = CollectSections(root);
  std::map<std::string, pugi::xml_node> binaries;
  for (pugi::xml_node b : root.children()) {
    if (!XmlNameIs(b, "binary")) continue;
    const std::string id = XmlAttr(b, "id");
    if (!id.empty()) binaries[id] = b;
  }
  sherpa_onnx::image::DecodeOptions dec;
  dec.maxSide = opt.max_side;
  std::set<std::string> seen;
  const int total = static_cast<int>(sections.size());
  for (int i = 0; i < total; ++i) {
    if (Cancelled(opt)) {
      r.error_code = kErrCancelled;
      r.error_message = "cancelled";
      return r;
    }
    Progress(opt, i, total, "section");
    const std::vector<HtmlBlock> items = SectionItems(sections[static_cast<size_t>(i)]);
    // Default scope: the image of each image-only section. `all_images`: every
    // image in reading order, once per binary.
    if (!opt.all_images && HasText(items)) continue;
    for (const HtmlBlock& item : items) {
      if (item.kind != HtmlBlockKind::Image) continue;
      const std::string href = Fb2ImageHref(item.image_src);
      if (href.empty() || !seen.insert(href).second) continue;
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
      if (!opt.all_images) break;  // one image per image-only section
    }
  }
  Progress(opt, total, total, "done");
  if (r.frames.empty()) {
    r.error_code = kErrNoImages;
    r.error_message = opt.all_images ? "No decodable FB2 images" : "No image-only FB2 sections";
    return r;
  }
  r.ok = true;
  return r;
}

}  // namespace document
}  // namespace sherpa_onnx
