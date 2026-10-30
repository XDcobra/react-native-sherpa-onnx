#include <gtest/gtest.h>

#include "ort/ApplyOrtProvider.h"

#include <onnxruntime/core/session/onnxruntime_c_api.h>

namespace {

const OrtApi* ResolveApi() {
  const OrtApiBase* base = OrtGetApiBase();
  if (base == nullptr || base->GetApi == nullptr) return nullptr;
  return base->GetApi(ORT_API_VERSION);
}

}  // namespace

TEST(ApplyOrtProvider, CpuEmptyAndUnknownDoNotThrow) {
  const OrtApi* api = ResolveApi();
  ASSERT_NE(api, nullptr);
  ASSERT_NE(api->CreateSessionOptions, nullptr);
  ASSERT_NE(api->ReleaseSessionOptions, nullptr);

  OrtSessionOptions* opts = nullptr;
  ASSERT_EQ(api->CreateSessionOptions(&opts), nullptr);
  ASSERT_NE(opts, nullptr);

  EXPECT_NO_THROW(sherpa_onnx::ApplyOrtProvider(api, opts, ""));
  EXPECT_NO_THROW(sherpa_onnx::ApplyOrtProvider(api, opts, "cpu"));
  EXPECT_NO_THROW(sherpa_onnx::ApplyOrtProvider(api, opts, "CPU"));
  EXPECT_NO_THROW(sherpa_onnx::ApplyOrtProvider(api, opts, "foo"));
  EXPECT_NO_THROW(sherpa_onnx::ApplyOrtProvider(api, opts, "qnn"));
  EXPECT_NO_THROW(sherpa_onnx::ApplyOrtProvider(nullptr, opts, "nnapi"));
  EXPECT_NO_THROW(sherpa_onnx::ApplyOrtProvider(api, nullptr, "nnapi"));

  api->ReleaseSessionOptions(opts);
}

TEST(ApplyOrtProvider, WrongPlatformDoesNotThrow) {
  const OrtApi* api = ResolveApi();
  ASSERT_NE(api, nullptr);
  OrtSessionOptions* opts = nullptr;
  ASSERT_EQ(api->CreateSessionOptions(&opts), nullptr);
  ASSERT_NE(opts, nullptr);

  EXPECT_NO_THROW(sherpa_onnx::ApplyOrtProvider(api, opts, "nnapi"));
  EXPECT_NO_THROW(sherpa_onnx::ApplyOrtProvider(api, opts, "xnnpack"));
  EXPECT_NO_THROW(sherpa_onnx::ApplyOrtProvider(api, opts, "coreml"));

  api->ReleaseSessionOptions(opts);
}
