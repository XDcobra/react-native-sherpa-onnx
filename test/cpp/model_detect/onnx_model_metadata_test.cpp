/**
 * Host tests for onnx-model-metadata (metadata scan without ORT) and the
 * speaker count of DetectTtsModel.
 */
#include "onnx-model-metadata.h"
#include "sherpa-onnx-model-detect.h"

#include <gtest/gtest.h>

#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>
#include <unordered_map>

namespace {

namespace fs = std::filesystem;
using sherpaonnx::model_detect::ReadOnnxMetadataInt;
using sherpaonnx::model_detect::ReadOnnxMetadataProps;
using sherpaonnx::model_detect::ReadSupertonicVoiceStyleSpeakerCount;

void PutVarint(std::string* out, uint64_t v) {
  while (v >= 0x80) {
    out->push_back(static_cast<char>((v & 0x7f) | 0x80));
    v >>= 7;
  }
  out->push_back(static_cast<char>(v));
}

void PutLengthDelimited(std::string* out, uint64_t field, const std::string& bytes) {
  PutVarint(out, (field << 3) | 2);
  PutVarint(out, bytes.size());
  out->append(bytes);
}

std::string Entry(const std::string& key, const std::string& value) {
  std::string e;
  PutLengthDelimited(&e, 1, key);
  PutLengthDelimited(&e, 2, value);
  return e;
}

/** ModelProto: ir_version, producer, a large graph, opset, then metadata. */
std::string FakeModel(const std::string& nSpeakers) {
  std::string m;
  PutVarint(&m, (1 << 3) | 0);  // ir_version
  PutVarint(&m, 8);
  PutLengthDelimited(&m, 2, "test");                     // producer_name
  PutLengthDelimited(&m, 7, std::string(1 << 20, 'g'));  // graph (skipped)
  std::string opset;
  PutVarint(&opset, (2 << 3) | 0);
  PutVarint(&opset, 17);
  PutLengthDelimited(&m, 8, opset);  // opset_import
  PutLengthDelimited(&m, 14, Entry("sample_rate", "22050"));
  PutLengthDelimited(&m, 14, Entry("n_speakers", nSpeakers));
  return m;
}

fs::path TempDir(const std::string& name) {
  fs::path dir = fs::temp_directory_path() / ("onnx_meta_test_" + name);
  fs::remove_all(dir);
  fs::create_directories(dir);
  return dir;
}

void WriteFile(const fs::path& path, const std::string& bytes) {
  std::ofstream out(path, std::ios::binary);
  out.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
}

}  // namespace

TEST(OnnxModelMetadata, ReadsPropsAfterLargeGraph) {
  const fs::path dir = TempDir("props");
  const fs::path model = dir / "model.onnx";
  WriteFile(model, FakeModel("904"));

  std::unordered_map<std::string, std::string> props;
  ASSERT_TRUE(ReadOnnxMetadataProps(model.string(), &props));
  EXPECT_EQ(props["sample_rate"], "22050");
  EXPECT_EQ(props["n_speakers"], "904");
  EXPECT_EQ(ReadOnnxMetadataInt(model.string(), "n_speakers", -1), 904);
  EXPECT_EQ(ReadOnnxMetadataInt(model.string(), "missing", -1), -1);
  fs::remove_all(dir);
}

TEST(OnnxModelMetadata, RejectsTruncatedOrMissingFile) {
  const fs::path dir = TempDir("truncated");
  const fs::path model = dir / "model.onnx";
  std::string bytes = FakeModel("2");
  WriteFile(model, bytes.substr(0, bytes.size() - 3));

  std::unordered_map<std::string, std::string> props;
  EXPECT_FALSE(ReadOnnxMetadataProps(model.string(), &props));
  EXPECT_EQ(ReadOnnxMetadataInt(model.string(), "n_speakers", -1), -1);
  EXPECT_EQ(ReadOnnxMetadataInt((dir / "none.onnx").string(), "n_speakers", -1), -1);
  fs::remove_all(dir);
}

TEST(OnnxModelMetadata, NonIntegerValueFallsBack) {
  const fs::path dir = TempDir("nonint");
  const fs::path model = dir / "model.onnx";
  WriteFile(model, FakeModel("many"));
  EXPECT_EQ(ReadOnnxMetadataInt(model.string(), "n_speakers", -1), -1);
  fs::remove_all(dir);
}

TEST(OnnxModelMetadata, SupertonicVoiceStyleHeader) {
  const fs::path dir = TempDir("supertonic");
  const int64_t good[6] = {10, 50, 256, 10, 8, 16};
  WriteFile(dir / "voice.bin",
            std::string(reinterpret_cast<const char*>(good), sizeof(good)) +
                std::string(64, '\0'));
  EXPECT_EQ(ReadSupertonicVoiceStyleSpeakerCount((dir / "voice.bin").string()), 10);

  const int64_t mismatch[6] = {10, 50, 256, 9, 8, 16};
  WriteFile(dir / "bad.bin",
            std::string(reinterpret_cast<const char*>(mismatch), sizeof(mismatch)));
  EXPECT_EQ(ReadSupertonicVoiceStyleSpeakerCount((dir / "bad.bin").string()), -1);
  EXPECT_EQ(ReadSupertonicVoiceStyleSpeakerCount((dir / "none.bin").string()), -1);
  fs::remove_all(dir);
}

TEST(OnnxModelMetadata, DetectTtsModelReportsVitsSpeakerCount) {
  const fs::path dir = TempDir("vits-piper-en_US-libritts_r-medium");
  WriteFile(dir / "en_US-libritts_r-medium.onnx", FakeModel("904"));
  WriteFile(dir / "tokens.txt", "_ 0\na 1\n");
  fs::create_directories(dir / "espeak-ng-data");
  WriteFile(dir / "espeak-ng-data" / "phontab", "x");

  const auto result =
      sherpaonnx::DetectTtsModel(dir.string(), std::nullopt, "auto", "");
  ASSERT_TRUE(result.ok) << result.error;
  EXPECT_EQ(result.selectedKind, sherpaonnx::TtsModelKind::kVits);
  EXPECT_EQ(result.numSpeakers, 904);
  fs::remove_all(dir);
}
