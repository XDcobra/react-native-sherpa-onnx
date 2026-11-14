#include <gtest/gtest.h>

#include "markup/OcrElementKind.h"
#include "markup/OcrOtsl.h"
#include "markup/OcrTable.h"

using sherpa_onnx::ocr::FromDocTagsTag;
using sherpa_onnx::ocr::FromNemotronClass;
using sherpa_onnx::ocr::OcrElementKind;
using sherpa_onnx::ocr::OcrTable;
using sherpa_onnx::ocr::OcrTableCell;
using sherpa_onnx::ocr::ParseGfmPipes;
using sherpa_onnx::ocr::ParseOtsl;
using sherpa_onnx::ocr::kOcrErrParseUnknownKind;

TEST(OcrTable, RenderGfmAndPlain) {
  OcrTable table;
  table.rows = {
      {OcrTableCell{"Month"}, OcrTableCell{"Units"}},
      {OcrTableCell{"Mon"}, OcrTableCell{"12"}},
      {OcrTableCell{"Tue"}, OcrTableCell{"18"}},
  };
  EXPECT_EQ(table.RenderPlain(), "Month | Units\nMon | 12\nTue | 18");
  EXPECT_EQ(table.RenderGfm(),
            "| Month | Units |\n| --- | --- |\n| Mon | 12 |\n| Tue | 18 |");
}

TEST(OcrTable, ParseChartPipes) {
  const auto table = ParseGfmPipes("Month | Units\nMon | 12\nTue | 18\nWed | 9");
  ASSERT_EQ(table.rows.size(), 4u);
  EXPECT_EQ(table.rows[0][0].text, "Month");
  EXPECT_EQ(table.rows[1][1].text, "12");
}

TEST(OcrOtsl, ParseCellStream) {
  const auto table = ParseOtsl("<fcel>Shift<fcel>Units<nl><fcel>Mon AM<fcel>3210<nl>");
  ASSERT_EQ(table.rows.size(), 2u);
  EXPECT_EQ(table.rows[0][0].text, "Shift");
  EXPECT_EQ(table.rows[0][1].text, "Units");
  EXPECT_EQ(table.rows[1][0].text, "Mon AM");
  EXPECT_EQ(table.rows[1][1].text, "3210");
}

TEST(OcrElementKind, TotalMaps) {
  const auto paragraph = FromDocTagsTag("paragraph");
  ASSERT_TRUE(paragraph.ok);
  EXPECT_EQ(paragraph.kind, OcrElementKind::kText);

  const auto header = FromDocTagsTag("section_header_level_2");
  ASSERT_TRUE(header.ok);
  EXPECT_EQ(header.kind, OcrElementKind::kSectionHeader);
  ASSERT_TRUE(header.level.has_value());
  EXPECT_EQ(*header.level, 2);

  const auto checked = FromDocTagsTag("checkbox_selected");
  ASSERT_TRUE(checked.ok);
  EXPECT_EQ(checked.kind, OcrElementKind::kCheckbox);
  ASSERT_TRUE(checked.checked.has_value());
  EXPECT_TRUE(*checked.checked);

  const auto unknown = FromDocTagsTag("not_a_tag");
  EXPECT_FALSE(unknown.ok);
  EXPECT_EQ(unknown.error_code, kOcrErrParseUnknownKind);

  const auto nemo = FromNemotronClass("<class_Section-header>");
  ASSERT_TRUE(nemo.ok);
  EXPECT_EQ(nemo.kind, OcrElementKind::kSectionHeader);

  const auto toc = FromNemotronClass("TOC");
  ASSERT_TRUE(toc.ok);
  EXPECT_EQ(toc.kind, OcrElementKind::kToc);
}

// ---- Markdown → reading text (paddleocr_vl, nemotron_parse) ----

#include "markup/OcrMarkdownText.h"

TEST(OcrMarkdownText, ParagraphsHeadingsListsAndTables) {
  const auto r = sherpa_onnx::ocr::MarkdownToReadingText(
      "# The Bay\n\nThe keeper **counted** the\nships every evening.\n\n"
      "## Notes\n- one\n- two\n\n| Ship | Count |\n| --- | --- |\n| Ada | 2 |\n"
      "<p>Done.</p>",
      /*soft_wrap=*/true, 3);
  EXPECT_EQ(r.text_utf8,
            "The Bay\n\nThe keeper counted the ships every evening.\n\nNotes\n\none\n\ntwo\n\n"
            "Ship | Count\nAda | 2\n\nDone.");
  ASSERT_EQ(r.elements.size(), 5u);
  EXPECT_EQ(r.elements[0].kind, sherpa_onnx::ocr::OcrElementKind::kTitle);
  EXPECT_EQ(*r.elements[0].heading_level, 1);
  EXPECT_EQ(r.elements[0].utf16_start, 0);
  EXPECT_EQ(r.elements[0].utf16_end, 7);
  EXPECT_EQ(r.elements[0].frame_index, 3);
  EXPECT_EQ(r.elements[1].kind, sherpa_onnx::ocr::OcrElementKind::kSectionHeader);
  EXPECT_EQ(*r.elements[1].heading_level, 2);
  EXPECT_EQ(r.elements[2].kind, sherpa_onnx::ocr::OcrElementKind::kListItem);
  EXPECT_EQ(r.elements[3].kind, sherpa_onnx::ocr::OcrElementKind::kListItem);
  EXPECT_EQ(r.elements[4].kind, sherpa_onnx::ocr::OcrElementKind::kTable);
  EXPECT_FALSE(r.elements[4].has_quad);
}

TEST(OcrMarkdownText, HardLinesKeepEveryLineAsABlock) {
  const auto r = sherpa_onnx::ocr::MarkdownToReadingText(
      "# Invoice\nItem Qty Price\nWidget 2 10", /*soft_wrap=*/false, 0);
  EXPECT_EQ(r.text_utf8, "Invoice\n\nItem Qty Price\n\nWidget 2 10");
  ASSERT_EQ(r.elements.size(), 1u);
  EXPECT_EQ(r.elements[0].kind, sherpa_onnx::ocr::OcrElementKind::kTitle);
}

TEST(OcrMarkdownText, EmptyAndUnderscoresInWords) {
  EXPECT_TRUE(sherpa_onnx::ocr::MarkdownToReadingText("\n \n", true, 0).text_utf8.empty());
  EXPECT_EQ(sherpa_onnx::ocr::MarkdownToReadingText("snake_case and __bold__", true, 0).text_utf8,
            "snake_case and bold");
}
