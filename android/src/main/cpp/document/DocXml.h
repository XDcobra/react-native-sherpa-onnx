#pragma once

#include "pugixml.hpp"

#include <cstring>
#include <string>

namespace sherpa_onnx {
namespace document {

/** Last path segment after ':' so default/prefixed xmlns both match. */
inline const char* XmlLocalName(const char* name) {
  if (!name || !*name) return "";
  const char* p = std::strrchr(name, ':');
  return p ? p + 1 : name;
}

inline bool XmlNameIs(pugi::xml_node n, const char* local) {
  return n && local && std::strcmp(XmlLocalName(n.name()), local) == 0;
}

inline pugi::xml_node XmlChild(pugi::xml_node parent, const char* local) {
  for (pugi::xml_node c : parent.children()) {
    if (XmlNameIs(c, local)) return c;
  }
  return {};
}

inline std::string XmlAttr(pugi::xml_node n, const char* local) {
  if (!n || !local) return {};
  for (pugi::xml_attribute a : n.attributes()) {
    if (std::strcmp(XmlLocalName(a.name()), local) == 0) {
      return a.value();
    }
  }
  return {};
}

inline pugi::xml_node XmlSelect(pugi::xml_node root, const char* local_name) {
  if (!root || !local_name) return {};
  std::string q = std::string(".//*[local-name()='") + local_name + "']";
  return root.select_node(q.c_str()).node();
}

}  // namespace document
}  // namespace sherpa_onnx
