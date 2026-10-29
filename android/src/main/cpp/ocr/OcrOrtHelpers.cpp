#include "OcrOrtHelpers.h"

#include "ort/ApplyOrtProvider.h"

#include <onnxruntime_cxx_api.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <filesystem>
#include <stdexcept>
#include <string>

#ifndef OCR_LOG_TAG
#define OCR_LOG_TAG "SherpaOnnx:ocr"
#endif

#if defined(__ANDROID__)
#include <android/log.h>
#define OCR_LOGI(...) __android_log_print(ANDROID_LOG_INFO, OCR_LOG_TAG, __VA_ARGS__)
#define OCR_LOGE(...) __android_log_print(ANDROID_LOG_ERROR, OCR_LOG_TAG, __VA_ARGS__)
#else
#include <cstdio>
#define OCR_LOGI(...)                          \
  do {                                         \
    std::fprintf(stderr, "[SherpaOnnx:ocr] "); \
    std::fprintf(stderr, __VA_ARGS__);         \
    std::fprintf(stderr, "\n");                \
  } while (0)
#define OCR_LOGE(...) OCR_LOGI(__VA_ARGS__)
#endif

namespace fs = std::filesystem;

namespace sherpa_onnx {
namespace ocr {

void OcrRequireRegularFile(const std::string& path, const char* who) {
  std::error_code ec;
  if (!fs::is_regular_file(path, ec) || ec) {
    throw std::runtime_error(std::string(who) + ": missing " + path);
  }
  if (fs::file_size(path, ec) == 0 || ec) {
    throw std::runtime_error(std::string(who) + ": empty " + path);
  }
}

int32_t OcrArgmax(const float* row, int n) {
  if (n <= 0 || row == nullptr) {
    throw std::runtime_error("OcrArgmax: empty logits row");
  }
  int best = 0;
  float best_v = row[0];
  for (int i = 1; i < n; ++i) {
    if (row[i] > best_v) {
      best_v = row[i];
      best = i;
    }
  }
  return best;
}

Ort::SessionOptions OcrMakeVlmSessionOptions(int num_threads,
                                             std::string_view provider) {
  Ort::SessionOptions options;
  options.SetIntraOpNumThreads(std::max(1, num_threads));
  options.SetInterOpNumThreads(1);
  options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_EXTENDED);
  // Phone-first: do not keep a growing arena or a packed copy of every
  // initializer. Dynamic vision shapes also make mem-pattern planning a
  // worst-case reserve. Same graphs, more malloc, lower peak RSS.
  options.DisableCpuMemArena();
  options.DisableMemPattern();
  options.AddConfigEntry("session.disable_prepacking", "1");
  ApplyOrtProvider(options, provider);
  return options;
}

std::unique_ptr<Ort::Session> OcrCreateOrtSession(
    Ort::Env& env, const Ort::SessionOptions& options, const std::string& path,
    const char* label, std::string_view provider) {
  const char* who = (label != nullptr && label[0] != '\0') ? label : "session";
  const std::string prov = provider.empty() ? "cpu" : std::string(provider);
  OCR_LOGI("ocr session create %s provider=%s path=%s", who, prov.c_str(), path.c_str());
  const auto t0 = std::chrono::steady_clock::now();
  OrtSession* raw = nullptr;
  OrtStatus* status =
      Ort::GetApi().CreateSession(env, path.c_str(), options, &raw);
  if (status != nullptr) {
    const char* msg = Ort::GetApi().GetErrorMessage(status);
    const std::string err =
        (msg != nullptr && msg[0] != '\0') ? msg : "unknown ONNX Runtime error";
    Ort::GetApi().ReleaseStatus(status);
    OCR_LOGE("ocr session create failed %s provider=%s: %s", who, prov.c_str(),
             err.c_str());
    throw std::runtime_error(std::string("OCR session '") + who + "' failed (" +
                             prov + "): " + err);
  }
  const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                      std::chrono::steady_clock::now() - t0)
                      .count();
  OCR_LOGI("ocr session create ok %s provider=%s %lld ms", who, prov.c_str(),
           static_cast<long long>(ms));
  return std::make_unique<Ort::Session>(raw);
}

std::vector<Ort::Value> OcrEmptyKvCache(const Ort::MemoryInfo& mem, int layers,
                                        int kv_heads, int head_dim) {
  if (layers <= 0 || kv_heads <= 0 || head_dim <= 0) {
    throw std::runtime_error("OcrEmptyKvCache: invalid KV geometry");
  }
  static float dummy = 0.f;
  const std::array<int64_t, 4> empty_shape{1, kv_heads, 0, head_dim};
  std::vector<Ort::Value> past;
  past.reserve(static_cast<size_t>(layers) * 2);
  for (int i = 0; i < layers * 2; ++i) {
    past.push_back(Ort::Value::CreateTensor<float>(mem, &dummy, 0, empty_shape.data(),
                                                   empty_shape.size()));
  }
  return past;
}

}  // namespace ocr
}  // namespace sherpa_onnx
