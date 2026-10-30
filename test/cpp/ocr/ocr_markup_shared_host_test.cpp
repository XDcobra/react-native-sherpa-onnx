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
