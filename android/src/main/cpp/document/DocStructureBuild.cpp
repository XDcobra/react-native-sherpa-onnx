#include "DocStructureBuild.h"

#include "DocPath.h"
#include "DocUtf16.h"

#include <algorithm>
#include <utility>

namespace sherpa_onnx {
namespace document {

void AppendStructureSection(ExtractTextResult* r, TxtStructure* st,
                            const StructureSectionInput& in, int* utf16_off) {
  TxtStructSection sec;
  sec.sectionIndex = in.section_index;
  sec.href = in.href;
  sec.kind = in.kind;
  sec.firstBlock = static_cast<int>(st->blocks.size());
  sec.utf16Start = *utf16_off;
  sec.utf16End = *utf16_off;
  bool has_text = false;
  std::string first_heading;
  const std::string base_dir = DirnameOf(in.href);

  auto push_block = [&](TxtStructBlock b) {
    b.sectionIndex = in.section_index;
    b.blockIndex = static_cast<int>(st->blocks.size()) - sec.firstBlock;
    st->blocks.push_back(std::move(b));
  };

  if (!in.raw_image_href.empty()) {
    TxtStructBlock b;
    b.type = TxtBlockType::Image;
    b.imageHref = in.raw_image_href;
    b.utf16Start = b.utf16End = *utf16_off;
    push_block(std::move(b));
  } else if (in.items) {
    for (const HtmlBlock& item : *in.items) {
      TxtStructBlock b;
      if (item.kind == HtmlBlockKind::Image || item.kind == HtmlBlockKind::Separator) {
        if (item.kind == HtmlBlockKind::Image) {
          b.type = TxtBlockType::Image;
          b.imageHref = in.resolve_image ? in.resolve_image(item.image_src)
                                         : JoinHref(base_dir, item.image_src);
          if (b.imageHref.empty()) continue;  // remote or empty src
          b.alt = item.alt;
          b.hasAlt = item.has_alt;
        } else {
          b.type = TxtBlockType::Separator;
        }
        b.utf16Start = b.utf16End = *utf16_off;
        push_block(std::move(b));
        continue;
      }
      if (*utf16_off > 0) {
        r->text += "\n\n";
        *utf16_off += 2;
      }
      const int start = *utf16_off;
      r->text += item.text;
      const int len = Utf16LengthOfUtf8(item.text);
      *utf16_off += len;
      DocTextSpan span;
      span.utf16_start = start;
      span.utf16_end = start + len;
      span.level = "block";
      span.section_index = in.section_index;
      span.href = in.href;
      r->spans.push_back(std::move(span));

      b.type = item.kind == HtmlBlockKind::Heading ? TxtBlockType::Heading
                                                   : TxtBlockType::Paragraph;
      b.headingLevel = item.level;
      b.utf16Start = start;
      b.utf16End = start + len;
      if (!has_text) sec.utf16Start = start;
      sec.utf16End = start + len;
      has_text = true;
      if (first_heading.empty() && b.type == TxtBlockType::Heading) {
        first_heading = item.text;
      }
      if (item.toc_level > 0) {
        TxtTocEntry e;
        e.title = item.text;
        std::replace(e.title.begin(), e.title.end(), '\n', ' ');
        e.level = item.toc_level;
        e.sectionIndex = in.section_index;
        e.blockIndex = static_cast<int>(st->blocks.size()) - sec.firstBlock;
        st->toc.push_back(std::move(e));
      }
      push_block(std::move(b));
    }
  }
  if (!has_text) sec.utf16Start = sec.utf16End = *utf16_off;
  sec.blockCount = static_cast<int>(st->blocks.size()) - sec.firstBlock;

  if (!in.toc_title.empty()) {
    sec.title = in.toc_title;
    sec.titleSource = "toc";
  } else if (!first_heading.empty()) {
    std::string h = first_heading;
    std::replace(h.begin(), h.end(), '\n', ' ');
    sec.title = h;
    sec.titleSource = "heading";
  }
  st->sections.push_back(std::move(sec));
}

}  // namespace document
}  // namespace sherpa_onnx
