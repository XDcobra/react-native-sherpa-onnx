/**
 * Host-side tests for android/.../audio_convert_file.cpp (same sources as Android JNI).
 */
#include "audio_convert_file.h"

#include <gtest/gtest.h>

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#if __has_include(<filesystem>)
#include <filesystem>
namespace fs = std::filesystem;
#else
#include <experimental/filesystem>
namespace fs = std::experimental::filesystem;
#endif

namespace {

std::string TempPath(const char* suffix) {
  auto dir = fs::temp_directory_path();
  auto base = std::string("sherpa_audio_convert_test_") +
              std::to_string(static_cast<unsigned long long>(
                  std::chrono::steady_clock::now().time_since_epoch().count())) +
              suffix;
  return (dir / base).string();
}

/** Minimal mono 16-bit PCM WAV for FFmpeg demux. */
void WriteMinimalWav(const std::string& path, int sample_rate,
                     const std::vector<int16_t>& samples) {
  const uint32_t data_size = static_cast<uint32_t>(samples.size() * 2);
  const uint32_t riff_chunk_size = 36 + data_size;
  std::ofstream f(path, std::ios::binary);
  ASSERT_TRUE(f.good());
  f.write("RIFF", 4);
  f.write(reinterpret_cast<const char*>(&riff_chunk_size), 4);
  f.write("WAVE", 4);
  f.write("fmt ", 4);
  uint32_t fmt_chunk_size = 16;
  f.write(reinterpret_cast<const char*>(&fmt_chunk_size), 4);
  uint16_t audio_format = 1;
  uint16_t num_channels = 1;
  uint32_t sr = static_cast<uint32_t>(sample_rate);
  uint32_t byte_rate = sr * 2;
  uint16_t block_align = 2;
  uint16_t bits_per_sample = 16;
  f.write(reinterpret_cast<const char*>(&audio_format), 2);
  f.write(reinterpret_cast<const char*>(&num_channels), 2);
  f.write(reinterpret_cast<const char*>(&sr), 4);
  f.write(reinterpret_cast<const char*>(&byte_rate), 4);
  f.write(reinterpret_cast<const char*>(&block_align), 2);
  f.write(reinterpret_cast<const char*>(&bits_per_sample), 2);
  f.write("data", 4);
  f.write(reinterpret_cast<const char*>(&data_size), 4);
  f.write(reinterpret_cast<const char*>(samples.data()),
          static_cast<std::streamsize>(samples.size() * sizeof(int16_t)));
  ASSERT_TRUE(f.good());
}

/** Run ffprobe; return true if stdout contains `needle` (e.g. codec name). */
bool FfprobeOutputContains(const std::string& media_path, const char* needle) {
  std::string cmd =
      "ffprobe -v error -show_entries stream=codec_name -of "
      "default=noprint_wrappers=1:nokey=1 \"" +
      media_path + "\" 2>/dev/null";
  FILE* pipe = popen(cmd.c_str(), "r");
  if (!pipe) return false;
  std::array<char, 512> buf{};
  std::string out;
  while (fgets(buf.data(), static_cast<int>(buf.size()), pipe)) {
    out += buf.data();
  }
  const int st = pclose(pipe);
  if (st != 0) return false;
  return out.find(needle) != std::string::npos;
}

}  // namespace

TEST(AudioConvertFile, WavToMp3_44100) {
  const int sr = 22050;
  std::vector<int16_t> samples(800);
  for (size_t i = 0; i < samples.size(); ++i) {
    samples[i] = static_cast<int16_t>(3000 * std::sin(static_cast<double>(i) * 0.1));
  }
  const std::string in_path = TempPath("_in.wav");
  const std::string out_path = TempPath("_out.mp3");
  WriteMinimalWav(in_path, sr, samples);

  const std::string err =
      sherpa_audio_convert_to_format(in_path.c_str(), out_path.c_str(), "mp3", 44100);
  if (!err.empty() && err.find("libshine") != std::string::npos) {
    GTEST_SKIP() << err;
  }
  ASSERT_TRUE(err.empty()) << err;
  EXPECT_TRUE(fs::exists(out_path));
  EXPECT_GT(fs::file_size(out_path), 0u);
  if (std::system("which ffprobe >/dev/null 2>&1") == 0) {
    EXPECT_TRUE(FfprobeOutputContains(out_path, "mp3"));
  }

  fs::remove(in_path);
  fs::remove(out_path);
}

TEST(AudioConvertFile, WavToFlac) {
  const int sr = 22050;
  std::vector<int16_t> samples(400);
  for (size_t i = 0; i < samples.size(); ++i) {
    samples[i] = static_cast<int16_t>(2000 * std::sin(static_cast<double>(i) * 0.05));
  }
  const std::string in_path = TempPath("_in.wav");
  const std::string out_path = TempPath("_out.flac");
  WriteMinimalWav(in_path, sr, samples);

  const std::string err =
      sherpa_audio_convert_to_format(in_path.c_str(), out_path.c_str(), "flac", 0);
  EXPECT_TRUE(err.empty()) << err;
  EXPECT_TRUE(fs::exists(out_path));
  EXPECT_GT(fs::file_size(out_path), 0u);
  if (std::system("which ffprobe >/dev/null 2>&1") == 0) {
    EXPECT_TRUE(FfprobeOutputContains(out_path, "flac"));
  }

  fs::remove(in_path);
  fs::remove(out_path);
}

TEST(AudioConvertFile, WavToWav16kMono) {
  const int sr = 44100;
  std::vector<int16_t> samples(5000);
  for (size_t i = 0; i < samples.size(); ++i) {
    samples[i] = static_cast<int16_t>(1000 * std::sin(static_cast<double>(i) * 0.02));
  }
  const std::string in_path = TempPath("_in.wav");
  const std::string out_path = TempPath("_out16k.wav");
  WriteMinimalWav(in_path, sr, samples);

  const std::string err = sherpa_audio_convert_to_wav16k_mono(in_path.c_str(), out_path.c_str());
  EXPECT_TRUE(err.empty()) << err;
  EXPECT_TRUE(fs::exists(out_path));
  EXPECT_GT(fs::file_size(out_path), 0u);

  std::vector<float> decoded;
  int out_sr = 0;
  const std::string dec_err =
      sherpa_audio_decode_file_to_float_mono(out_path.c_str(), 0, &decoded, &out_sr);
  EXPECT_TRUE(dec_err.empty()) << dec_err;
  EXPECT_EQ(out_sr, 16000);
  EXPECT_FALSE(decoded.empty());

  fs::remove(in_path);
  fs::remove(out_path);
}
