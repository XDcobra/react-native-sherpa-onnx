/**
 * Host-side tests for audio_f32le_to_format_body.inc.cpp (same TU as Android JNI wrapper).
 * convertF32leMonoFileToFormat is static in the include — tests must live in this file after the include.
 */
#include <gtest/gtest.h>

#include <chrono>
#include <cmath>
#include <cstdio>
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

#include <sys/stat.h>

#define LOG_TAG "AudioF32leHost"
#ifdef __ANDROID__
#include <android/log.h>
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, LOG_TAG, __VA_ARGS__)
#else
#define LOGI(...) ((void)0)
#define LOGE(...) ((void)0)
#define LOGW(...) ((void)0)
#endif

#ifdef HAVE_FFMPEG
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/opt.h>
#include <libavutil/error.h>
#include <libswresample/swresample.h>
}
#endif

#include "../../../android/src/main/cpp/jni/audio/audio_f32le_to_format_body.inc.cpp"

namespace {

std::string TempPath(const char* suffix) {
  auto dir = fs::temp_directory_path();
  auto base = std::string("sherpa_f32le_test_") +
              std::to_string(static_cast<unsigned long long>(
                  std::chrono::steady_clock::now().time_since_epoch().count())) +
              suffix;
  return (dir / base).string();
}

void WriteMonoF32LeRaw(const std::string& path, int num_samples) {
  std::ofstream f(path, std::ios::binary);
  ASSERT_TRUE(f.good());
  for (int i = 0; i < num_samples; ++i) {
    float v = 0.1f * std::sin(static_cast<double>(i) * 0.15);
    f.write(reinterpret_cast<const char*>(&v), sizeof(float));
  }
  ASSERT_TRUE(f.good());
}

bool FfprobeContains(const std::string& media_path, const char* needle) {
  std::string cmd =
      "ffprobe -v error -show_entries stream=codec_name -of "
      "default=noprint_wrappers=1:nokey=1 \"" +
      media_path + "\" 2>/dev/null";
  FILE* pipe = popen(cmd.c_str(), "r");
  if (!pipe) return false;
  char buf[512];
  std::string out;
  while (fgets(buf, sizeof(buf), pipe)) {
    out += buf;
  }
  const int st = pclose(pipe);
  if (st != 0) return false;
  return out.find(needle) != std::string::npos;
}

}  // namespace

TEST(F32leToFormat, RawToMp3) {
  const int pcm_sr = 24000;
  const std::string raw_path = TempPath(".raw");
  const std::string out_path = TempPath(".mp3");
  WriteMonoF32LeRaw(raw_path, 12000);

  const std::string err =
      convertF32leMonoFileToFormat(raw_path.c_str(), pcm_sr, out_path.c_str(), "mp3", 48000);
  if (!err.empty() && err.find("libshine") != std::string::npos) {
    GTEST_SKIP() << err;
  }
  ASSERT_TRUE(err.empty()) << err;
  EXPECT_TRUE(fs::exists(out_path));
  EXPECT_GT(fs::file_size(out_path), 0u);
  if (std::system("which ffprobe >/dev/null 2>&1") == 0) {
    EXPECT_TRUE(FfprobeContains(out_path, "mp3"));
  }

  fs::remove(raw_path);
  fs::remove(out_path);
}

TEST(F32leToFormat, RawToFlac) {
  const int pcm_sr = 22050;
  const std::string raw_path = TempPath(".raw");
  const std::string out_path = TempPath(".flac");
  WriteMonoF32LeRaw(raw_path, 8000);

  const std::string err =
      convertF32leMonoFileToFormat(raw_path.c_str(), pcm_sr, out_path.c_str(), "flac", 0);
  EXPECT_TRUE(err.empty()) << err;
  EXPECT_TRUE(fs::exists(out_path));
  EXPECT_GT(fs::file_size(out_path), 0u);
  if (std::system("which ffprobe >/dev/null 2>&1") == 0) {
    EXPECT_TRUE(FfprobeContains(out_path, "flac"));
  }

  fs::remove(raw_path);
  fs::remove(out_path);
}
