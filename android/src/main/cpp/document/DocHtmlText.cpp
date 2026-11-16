#include "DocHtmlText.h"

#include <cstring>

#if defined(SHERPA_ONNX_HAS_LEXBOR) && SHERPA_ONNX_HAS_LEXBOR

#include <lexbor/dom/interface.h>
#include <lexbor/dom/interfaces/character_data.h>
#include <lexbor/html/html.h>
#include <lexbor/html/parser.h>

namespace sherpa_onnx {
namespace document {

namespace {

bool IsSkipTag(lxb_tag_id_t id) {
  return id == LXB_TAG_SCRIPT || id == LXB_TAG_STYLE || id == LXB_TAG_HEAD ||
         id == LXB_TAG_TEMPLATE || id == LXB_TAG_RT || id == LXB_TAG_RP ||
         id == LXB_TAG_NOSCRIPT || id == LXB_TAG_IFRAME || id == LXB_TAG_META ||
         id == LXB_TAG_LINK || id == LXB_TAG_TITLE;
}

bool IsBlockTag(lxb_tag_id_t id) {
  return id == LXB_TAG_P || id == LXB_TAG_H1 || id == LXB_TAG_H2 ||
         id == LXB_TAG_H3 || id == LXB_TAG_H4 || id == LXB_TAG_H5 ||
         id == LXB_TAG_H6 || id == LXB_TAG_LI || id == LXB_TAG_BLOCKQUOTE ||
         id == LXB_TAG_PRE || id == LXB_TAG_TD;
}

bool IsWs(char c) {
  return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f';
}

int HeadingLevel(lxb_tag_id_t id) {
  switch (id) {
    case LXB_TAG_H1: return 1;
    case LXB_TAG_H2: return 2;
    case LXB_TAG_H3: return 3;
    case LXB_TAG_H4: return 4;
    case LXB_TAG_H5: return 5;
    case LXB_TAG_H6: return 6;
    default: return 0;
  }
}

std::string AttrVal(lxb_dom_element_t* el, const char* name) {
  if (!el || !name) return {};
  const lxb_char_t* v = lxb_dom_element_get_attribute(
      el, reinterpret_cast<const lxb_char_t*>(name), std::strlen(name), nullptr);
  if (!v) return {};
  return reinterpret_cast<const char*>(v);
}

struct WalkState {
  HtmlExtract* out = nullptr;
  std::string cur;  // text of the block being collected
  // Style flags (TxtStyleFlags) of each byte of `cur`, for the block's style runs.
  std::vector<uint8_t> cur_flags;
  uint8_t style = 0;  // flags of the text being walked
  int block_depth = 0;  // open block elements
  int pre_depth = 0;
  // Kind of the innermost open block (paragraph at body level).
  std::vector<HtmlBlock> kind_stack;
  // Images / separators met inside an open block, emitted after it.
  std::vector<HtmlBlock> pending;
};

void AppendText(WalkState* st, const char* data, size_t len) {
  if (!data || len == 0) return;
  if (st->pre_depth > 0) {
    st->cur.append(data, len);
    st->cur_flags.insert(st->cur_flags.end(), len, st->style);
    return;
  }
  for (size_t i = 0; i < len; ++i) {
    const char c = data[i];
    if (IsWs(c)) {
      if (st->cur.empty() || st->cur.back() == ' ' || st->cur.back() == '\n') {
        continue;
      }
      st->cur.push_back(' ');
    } else {
      st->cur.push_back(c);
    }
    st->cur_flags.push_back(st->style);
  }
}

void AppendBreak(WalkState* st) {
  if (st->pre_depth == 0) {
    while (!st->cur.empty() && st->cur.back() == ' ') {
      st->cur.pop_back();
      st->cur_flags.pop_back();
    }
  }
  st->cur.push_back('\n');
  st->cur_flags.push_back(st->style);
}

/** Removes spaces next to line breaks (collapsed text only). */
std::string TidyLines(const std::string& s) {
  std::string out;
  out.reserve(s.size());
  for (size_t i = 0; i < s.size(); ++i) {
    const char c = s[i];
    if (c == ' ' && ((i + 1 < s.size() && s[i + 1] == '\n') ||
                     (!out.empty() && out.back() == '\n'))) {
      continue;
    }
    out.push_back(c);
  }
  return out;
}

bool IsTrimWs(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

/**
 * TrimWs + TidyLines over `cur` that keeps each byte's style flags, so style
 * runs are computed on the final block string.
 */
void TrimAndTidyFlags(const std::string& cur, const std::vector<uint8_t>& cur_flags, bool pre,
                      std::string* text, std::vector<uint8_t>* flags) {
  size_t a = 0;
  size_t b = cur.size();
  while (a < b && IsTrimWs(cur[a])) ++a;
  while (b > a && IsTrimWs(cur[b - 1])) --b;
  text->clear();
  flags->clear();
  text->reserve(b - a);
  flags->reserve(b - a);
  for (size_t i = a; i < b; ++i) {
    const char c = cur[i];
    if (!pre && c == ' ' && ((i + 1 < b && cur[i + 1] == '\n') ||
                             (!text->empty() && text->back() == '\n'))) {
      continue;
    }
    text->push_back(c);
    flags->push_back(cur_flags[i]);
  }
}

void FlushBlock(WalkState* st, const HtmlBlock& kind, bool pre) {
  std::string t = TrimWs(st->cur);
  if (!pre) t = TidyLines(t);
  std::vector<TxtStyleRun> styles;
  if (!t.empty() && st->cur_flags.size() == st->cur.size()) {
    std::string styled;
    std::vector<uint8_t> flags;
    TrimAndTidyFlags(st->cur, st->cur_flags, pre, &styled, &flags);
    // The text stays exactly what TrimWs / TidyLines give; styles only when they line up.
    if (styled == t) styles = StyleRunsFromByteFlags(t, flags);
  }
  st->cur.clear();
  st->cur_flags.clear();
  if (!t.empty()) {
    HtmlBlock b = kind;
    b.text = t;
    b.styles = std::move(styles);
    st->out->blocks.push_back(t);
    st->out->items.push_back(std::move(b));
  }
}

const HtmlBlock& CurrentKind(const WalkState& st) {
  static const HtmlBlock kParagraph{};
  return st.kind_stack.empty() ? kParagraph : st.kind_stack.back();
}

/** Emits images / separators collected inside a block once it is closed. */
void FlushPending(WalkState* st) {
  for (auto& item : st->pending) st->out->items.push_back(std::move(item));
  st->pending.clear();
}

/** An image or separator: after the open block, or right away at body level. */
void EmitNonText(WalkState* st, HtmlBlock item) {
  if (st->block_depth > 0) {
    st->pending.push_back(std::move(item));
    return;
  }
  FlushBlock(st, CurrentKind(*st), st->pre_depth > 0);
  st->out->items.push_back(std::move(item));
}

HtmlBlock ImageItem(lxb_dom_element_t* el, bool svg) {
  HtmlBlock b;
  b.kind = HtmlBlockKind::Image;
  if (svg) {
    b.image_src = AttrVal(el, "href");
    if (b.image_src.empty()) b.image_src = AttrVal(el, "xlink:href");
  } else {
    b.image_src = AttrVal(el, "src");
    if (b.image_src.empty()) b.image_src = AttrVal(el, "href");
    if (b.image_src.empty()) {
      // MOBI7: <img recindex="00001"> points at the first image record.
      const std::string rec = AttrVal(el, "recindex");
      if (!rec.empty()) b.image_src = "recindex:" + rec;
    }
    const lxb_char_t* alt = lxb_dom_element_get_attribute(
        el, reinterpret_cast<const lxb_char_t*>("alt"), 3, nullptr);
    if (alt) {
      b.has_alt = true;
      b.alt = TrimWs(reinterpret_cast<const char*>(alt));
    }
  }
  return b;
}

/** Lowercase copy without ASCII whitespace ("Font-Style : Italic" → "font-style:italic"). */
std::string CompactLower(const std::string& s) {
  std::string out;
  out.reserve(s.size());
  for (char c : s) {
    if (IsWs(c)) continue;
    out.push_back(c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c);
  }
  return out;
}

/** Value of a declaration in a compacted inline `style` (last one wins); "" if absent. */
std::string CssValue(const std::string& css, const std::string& prop) {
  std::string value;
  size_t pos = 0;
  while ((pos = css.find(prop + ":", pos)) != std::string::npos) {
    const bool start = pos == 0 || css[pos - 1] == ';' || css[pos - 1] == '{';
    const size_t v = pos + prop.size() + 1;
    if (start) {
      const size_t e = css.find_first_of(";!", v);
      value = css.substr(v, e == std::string::npos ? std::string::npos : e - v);
    }
    pos = v;
  }
  return value;
}

/**
 * Style flags inside an element: em / i / cite / dfn / var add italic, strong / b
 * add bold, and an inline `style` with font-style / font-weight sets or clears
 * them. Stylesheets and classes are not read.
 */
uint8_t ElementStyle(lxb_dom_element_t* el, lxb_tag_id_t id, uint8_t parent) {
  uint8_t f = parent;
  if (id == LXB_TAG_EM || id == LXB_TAG_I || id == LXB_TAG_CITE || id == LXB_TAG_DFN ||
      id == LXB_TAG_VAR) {
    f |= kTxtStyleItalic;
  } else if (id == LXB_TAG_STRONG || id == LXB_TAG_B) {
    f |= kTxtStyleBold;
  }
  const std::string css = CompactLower(AttrVal(el, "style"));
  if (css.empty()) return f;
  const std::string fs = CssValue(css, "font-style");
  if (fs == "italic" || fs == "oblique" || fs.rfind("oblique", 0) == 0) {
    f |= kTxtStyleItalic;
  } else if (fs == "normal") {
    f &= static_cast<uint8_t>(~kTxtStyleItalic);
  }
  const std::string fw = CssValue(css, "font-weight");
  if (fw == "bold" || fw == "bolder" || fw == "600" || fw == "700" || fw == "800" ||
      fw == "900") {
    f |= kTxtStyleBold;
  } else if (fw == "normal" || fw == "lighter" || fw == "100" || fw == "200" || fw == "300" ||
             fw == "400" || fw == "500") {
    f &= static_cast<uint8_t>(~kTxtStyleBold);
  }
  return f;
}

void Walk(lxb_dom_node_t* node, WalkState* st, bool skipping) {
  for (lxb_dom_node_t* n = node; n != nullptr; n = n->next) {
    if (n->type == LXB_DOM_NODE_TYPE_TEXT) {
      if (!skipping) {
        auto* cd = lxb_dom_interface_character_data(n);
        if (cd && cd->data.data && cd->data.length > 0) {
          AppendText(st, reinterpret_cast<const char*>(cd->data.data),
                     cd->data.length);
        }
      }
      continue;
    }
    if (n->type != LXB_DOM_NODE_TYPE_ELEMENT) {
      if (n->first_child) {
        Walk(n->first_child, st, skipping);
      }
      continue;
    }
    auto* el = lxb_dom_interface_element(n);
    const lxb_tag_id_t id = lxb_dom_element_tag_id(el);
    if (skipping || IsSkipTag(id)) {
      continue;
    }
    if (id == LXB_TAG_BR) {
      AppendBreak(st);
      continue;
    }
    if (id == LXB_TAG_HR) {
      HtmlBlock sep;
      sep.kind = HtmlBlockKind::Separator;
      EmitNonText(st, std::move(sep));
      continue;
    }
    if (id == LXB_TAG_IMG || id == LXB_TAG_IMAGE) {
      HtmlBlock img = ImageItem(el, id == LXB_TAG_IMAGE);
      if (!img.image_src.empty()) EmitNonText(st, std::move(img));
      continue;
    }
    const bool block = IsBlockTag(id);
    const bool pre = id == LXB_TAG_PRE;
    if (block) {
      // Loose text before this block belongs to the enclosing block.
      FlushBlock(st, CurrentKind(*st), st->pre_depth > 0);
      HtmlBlock kind;
      const int level = HeadingLevel(id);
      if (level > 0) {
        kind.kind = HtmlBlockKind::Heading;
        kind.level = level;
      }
      st->kind_stack.push_back(kind);
      ++st->block_depth;
      if (pre) ++st->pre_depth;
    }
    if (n->first_child) {
      const uint8_t outer = st->style;
      st->style = ElementStyle(el, id, outer);
      Walk(n->first_child, st, false);
      st->style = outer;
    }
    if (block) {
      FlushBlock(st, CurrentKind(*st), st->pre_depth > 0);
      if (pre) --st->pre_depth;
      --st->block_depth;
      st->kind_stack.pop_back();
      if (st->block_depth == 0) FlushPending(st);
    }
  }
}

}  // namespace

HtmlExtract ExtractHtmlText(const uint8_t* data, size_t size) {
  HtmlExtract out;
  if (!data || size == 0) return out;

  lxb_html_document_t* doc = lxb_html_document_create();
  if (!doc) return out;
  const lxb_status_t st = lxb_html_document_parse(
      doc, data, size);
  if (st != LXB_STATUS_OK) {
    lxb_html_document_destroy(doc);
    return out;
  }

  lxb_dom_node_t* body = lxb_dom_interface_node(lxb_html_document_body_element(doc));
  lxb_dom_node_t* root = body;
  if (!root) {
    root = lxb_dom_interface_node(doc);
  }
  WalkState walk;
  walk.out = &out;
  if (root && root->first_child) {
    Walk(root->first_child, &walk, false);
  }
  FlushBlock(&walk, CurrentKind(walk), false);
  FlushPending(&walk);

  std::string joined;
  for (size_t i = 0; i < out.blocks.size(); ++i) {
    if (i > 0) joined += "\n\n";
    joined += out.blocks[i];
  }
  out.text = joined;
  lxb_html_document_destroy(doc);
  return out;
}

namespace {

std::string FindImg(lxb_dom_node_t* node) {
  for (lxb_dom_node_t* n = node; n != nullptr; n = n->next) {
    if (n->type == LXB_DOM_NODE_TYPE_ELEMENT) {
      auto* el = lxb_dom_interface_element(n);
      const lxb_tag_id_t id = lxb_dom_element_tag_id(el);
      if (id == LXB_TAG_IMG) {
        std::string s = AttrVal(el, "src");
        if (s.empty()) s = AttrVal(el, "href");
        if (!s.empty()) return s;
      }
      if (id == LXB_TAG_IMAGE) {
        std::string s = AttrVal(el, "href");
        if (s.empty()) s = AttrVal(el, "xlink:href");
        if (!s.empty()) return s;
      }
    }
    if (n->first_child) {
      std::string nested = FindImg(n->first_child);
      if (!nested.empty()) return nested;
    }
  }
  return {};
}

std::string FindRecindex(lxb_dom_node_t* node) {
  for (lxb_dom_node_t* n = node; n != nullptr; n = n->next) {
    if (n->type == LXB_DOM_NODE_TYPE_ELEMENT) {
      auto* el = lxb_dom_interface_element(n);
      const lxb_tag_id_t id = lxb_dom_element_tag_id(el);
      if (id == LXB_TAG_IMG) {
        std::string s = AttrVal(el, "recindex");
        if (!s.empty()) return s;
      }
    }
    if (n->first_child) {
      std::string nested = FindRecindex(n->first_child);
      if (!nested.empty()) return nested;
    }
  }
  return {};
}

}  // namespace

std::string FirstImageHref(const uint8_t* data, size_t size) {
  if (!data || size == 0) return {};
  lxb_html_document_t* doc = lxb_html_document_create();
  if (!doc) return {};
  if (lxb_html_document_parse(doc, data, size) != LXB_STATUS_OK) {
    lxb_html_document_destroy(doc);
    return {};
  }
  lxb_dom_node_t* root = lxb_dom_interface_node(doc);
  std::string href = root ? FindImg(root) : std::string();
  lxb_html_document_destroy(doc);
  return href;
}

std::string FirstImageRecindex(const uint8_t* data, size_t size) {
  if (!data || size == 0) return {};
  lxb_html_document_t* doc = lxb_html_document_create();
  if (!doc) return {};
  if (lxb_html_document_parse(doc, data, size) != LXB_STATUS_OK) {
    lxb_html_document_destroy(doc);
    return {};
  }
  lxb_dom_node_t* root = lxb_dom_interface_node(doc);
  std::string v = root ? FindRecindex(root) : std::string();
  lxb_html_document_destroy(doc);
  return v;
}

}  // namespace document
}  // namespace sherpa_onnx

#else  // !SHERPA_ONNX_HAS_LEXBOR

namespace sherpa_onnx {
namespace document {

namespace {

constexpr const char* kLexborDisabledMsg =
    "lexbor is not linked. Rebuild with sherpaOnnxEnableLexbor=true "
    "(Android) or SHERPA_ONNX_ENABLE_LEXBOR=1 (iOS).";

}  // namespace

HtmlExtract ExtractHtmlText(const uint8_t* data, size_t size) {
  (void)data;
  (void)size;
  HtmlExtract out;
  out.error_code = kErrLexborDisabled;
  out.error_message = kLexborDisabledMsg;
  return out;
}

std::string FirstImageHref(const uint8_t* data, size_t size) {
  (void)data;
  (void)size;
  return {};
}

std::string FirstImageRecindex(const uint8_t* data, size_t size) {
  (void)data;
  (void)size;
  return {};
}

}  // namespace document
}  // namespace sherpa_onnx

#endif  // SHERPA_ONNX_HAS_LEXBOR
