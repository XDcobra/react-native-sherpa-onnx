#include "ort/ApplyOrtProvider.h"

#include <cctype>
#include <cstdio>
#include <string>
#include <vector>

#if defined(__has_include)
#if __has_include(<onnxruntime/core/session/onnxruntime_c_api.h>)
#include <onnxruntime/core/session/onnxruntime_c_api.h>
#elif __has_include(<onnxruntime_c_api.h>)
#include <onnxruntime_c_api.h>
#endif
#if defined(__APPLE__)
#if __has_include(<onnxruntime/core/providers/coreml/coreml_provider_factory.h>)
#include <onnxruntime/core/providers/coreml/coreml_provider_factory.h>
#define SHERPA_ONNX_HAS_COREML_FACTORY 1
#elif __has_include(<onnxruntime/coreml_provider_factory.h>)
#include <onnxruntime/coreml_provider_factory.h>
#define SHERPA_ONNX_HAS_COREML_FACTORY 1
#elif __has_include(<coreml_provider_factory.h>)
#include <coreml_provider_factory.h>
#define SHERPA_ONNX_HAS_COREML_FACTORY 1
#elif __has_include("coreml_provider_factory.h")
#include "coreml_provider_factory.h"
#define SHERPA_ONNX_HAS_COREML_FACTORY 1
#endif
#endif
#if defined(__ANDROID__)
#if __has_include(<onnxruntime/core/providers/nnapi/nnapi_provider_factory.h>)
#include <onnxruntime/core/providers/nnapi/nnapi_provider_factory.h>
#define SHERPA_ONNX_HAS_NNAPI_FACTORY 1
#elif __has_include(<nnapi_provider_factory.h>)
#include <nnapi_provider_factory.h>
#define SHERPA_ONNX_HAS_NNAPI_FACTORY 1
#elif __has_include("nnapi_provider_factory.h")
#include "nnapi_provider_factory.h"
#define SHERPA_ONNX_HAS_NNAPI_FACTORY 1
#endif
#endif
#endif

#if defined(__ANDROID__)
#include <android/log.h>
#define ORT_PROVIDER_LOGI(...) \
  __android_log_print(ANDROID_LOG_INFO, "SherpaOnnx:ort", __VA_ARGS__)
#else
#define ORT_PROVIDER_LOGI(...)                          \
  do {                                                  \
    std::fprintf(stderr, "[SherpaOnnx:ort] ");          \
    std::fprintf(stderr, __VA_ARGS__);                  \
    std::fprintf(stderr, "\n");                         \
  } while (0)
#endif

namespace sherpa_onnx {
namespace {

enum class ProviderKind { kCpu, kXnnpack, kNnapi, kCoreMl, kUnknown };

std::string ToLower(std::string_view raw) {
  std::string out(raw);
  for (char& c : out) {
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  }
  return out;
}

ProviderKind ParseKind(std::string_view raw) {
  const std::string s = ToLower(raw);
  if (s.empty() || s == "cpu") return ProviderKind::kCpu;
  if (s == "xnnpack") return ProviderKind::kXnnpack;
  if (s == "nnapi") return ProviderKind::kNnapi;
  if (s == "coreml") return ProviderKind::kCoreMl;
  return ProviderKind::kUnknown;
}

std::string JoinAvailable(const OrtApi* api) {
  if (api == nullptr || api->GetAvailableProviders == nullptr ||
      api->ReleaseAvailableProviders == nullptr) {
    return {};
  }
  char** names = nullptr;
  int len = 0;
  OrtStatus* status = api->GetAvailableProviders(&names, &len);
  if (status != nullptr) {
    api->ReleaseStatus(status);
    return {};
  }
  std::string joined;
  for (int i = 0; i < len; ++i) {
    if (names[i] == nullptr) continue;
    if (!joined.empty()) joined += ", ";
    joined += names[i];
  }
  (void)api->ReleaseAvailableProviders(names, len);
  return joined;
}

bool HasAvailable(const OrtApi* api, const char* name) {
  if (api == nullptr || name == nullptr || api->GetAvailableProviders == nullptr ||
      api->ReleaseAvailableProviders == nullptr) {
    return false;
  }
  char** names = nullptr;
  int len = 0;
  OrtStatus* status = api->GetAvailableProviders(&names, &len);
  if (status != nullptr) {
    api->ReleaseStatus(status);
    return false;
  }
  bool found = false;
  for (int i = 0; i < len; ++i) {
    if (names[i] != nullptr && std::string(names[i]) == name) {
      found = true;
      break;
    }
  }
  (void)api->ReleaseAvailableProviders(names, len);
  return found;
}

void ReleaseIfStatus(const OrtApi* api, OrtStatus* status, const char* what,
                     const std::string& available) {
  if (status == nullptr) return;
  const char* msg =
      api != nullptr && api->GetErrorMessage != nullptr ? api->GetErrorMessage(status) : "";
  ORT_PROVIDER_LOGI("Failed to enable %s: %s. Available providers: %s. Fallback to cpu", what,
                    msg != nullptr ? msg : "", available.c_str());
  if (api != nullptr && api->ReleaseStatus != nullptr) {
    api->ReleaseStatus(status);
  }
}

}  // namespace

void ApplyOrtProvider(const OrtApi* api, OrtSessionOptions* options,
                      std::string_view provider) {
  if (api == nullptr || options == nullptr) return;

  const ProviderKind kind = ParseKind(provider);
  if (kind == ProviderKind::kCpu) return;

  const std::string available = JoinAvailable(api);
  if (kind == ProviderKind::kUnknown) {
    const std::string raw(provider);
    ORT_PROVIDER_LOGI("Unsupported string: %s. Fallback to cpu", raw.c_str());
    return;
  }

  if (kind == ProviderKind::kXnnpack) {
    if (!HasAvailable(api, "XnnpackExecutionProvider") ||
        api->SessionOptionsAppendExecutionProvider == nullptr) {
      ORT_PROVIDER_LOGI("Available providers: %s. Fallback to cpu!", available.c_str());
      return;
    }
    OrtStatus* status =
        api->SessionOptionsAppendExecutionProvider(options, "XNNPACK", nullptr, nullptr, 0);
    ReleaseIfStatus(api, status, "XNNPACK", available);
    return;
  }

  if (kind == ProviderKind::kNnapi) {
#if defined(__ANDROID__) && defined(SHERPA_ONNX_HAS_NNAPI_FACTORY)
    uint32_t nnapi_flags = 0;
    OrtStatus* status = OrtSessionOptionsAppendExecutionProvider_Nnapi(options, nnapi_flags);
    if (status != nullptr) {
      ReleaseIfStatus(api, status, "NNAPI", available);
    } else {
      ORT_PROVIDER_LOGI("enabled NNAPI available=%s", available.c_str());
    }
#elif defined(__ANDROID__)
    ORT_PROVIDER_LOGI("NNAPI factory header not found at build time. Fallback to cpu");
#else
    ORT_PROVIDER_LOGI("NNAPI is for Android only. Fallback to cpu");
#endif
    return;
  }

  if (kind == ProviderKind::kCoreMl) {
#if defined(__APPLE__) && defined(SHERPA_ONNX_HAS_COREML_FACTORY)
    uint32_t coreml_flags = 0;
    OrtStatus* status = OrtSessionOptionsAppendExecutionProvider_CoreML(options, coreml_flags);
    if (status != nullptr) {
      ReleaseIfStatus(api, status, "CoreML", available);
    } else {
      ORT_PROVIDER_LOGI("enabled CoreML available=%s", available.c_str());
    }
#elif defined(__APPLE__)
    ORT_PROVIDER_LOGI("CoreML factory header not found at build time. Fallback to cpu");
#else
    ORT_PROVIDER_LOGI(
        "CoreML is for Apple only since onnxruntime>=1.15. Fallback to cpu!");
#endif
    return;
  }
}

}  // namespace sherpa_onnx
