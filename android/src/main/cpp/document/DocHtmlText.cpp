#include "DocHtmlText.h"

#include <cstring>

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

void AppendText(std::string* cur, const char* data, size_t len) {
  if (!cur || !data || len == 0) return;
  cur->append(data, len);
}

void FlushBlock(HtmlExtract* out, std::string* cur) {
  const std::string t = TrimWs(*cur);
  cur->clear();
  if (t.empty()) return;
  out->blocks.push_back(t);
}

void Walk(lxb_dom_node_t* node, HtmlExtract* out, std::string* cur,
          bool skipping) {
  for (lxb_dom_node_t* n = node; n != nullptr; n = n->next) {
    if (n->type == LXB_DOM_NODE_TYPE_TEXT) {
      if (!skipping) {
        auto* cd = lxb_dom_interface_character_data(n);
        if (cd && cd->data.data && cd->data.length > 0) {
          AppendText(cur, reinterpret_cast<const char*>(cd->data.data),
                     cd->data.length);
        }
      }
      continue;
    }
    if (n->type != LXB_DOM_NODE_TYPE_ELEMENT) {
      if (n->first_child) {
        Walk(n->first_child, out, cur, skipping);
      }
      continue;
    }
    auto* el = lxb_dom_interface_element(n);
    const lxb_tag_id_t id = lxb_dom_element_tag_id(el);
    if (id == LXB_TAG_BR) {
      if (!skipping) AppendText(cur, "\n", 1);
      continue;
    }
    const bool skip_here = skipping || IsSkipTag(id);
    const bool block = !skip_here && IsBlockTag(id);
    if (block) {
      FlushBlock(out, cur);
    }
    if (n->first_child) {
      Walk(n->first_child, out, cur, skip_here);
    }
    if (block) {
      FlushBlock(out, cur);
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
  std::string cur;
  if (root && root->first_child) {
    Walk(root->first_child, &out, &cur, false);
  }
  FlushBlock(&out, &cur);

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

std::string AttrVal(lxb_dom_element_t* el, const char* name) {
  if (!el || !name) return {};
  const lxb_char_t* v = lxb_dom_element_get_attribute(
      el, reinterpret_cast<const lxb_char_t*>(name), std::strlen(name), nullptr);
  if (!v) return {};
  return reinterpret_cast<const char*>(v);
}

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

}  // namespace document
}  // namespace sherpa_onnx
