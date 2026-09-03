#include "pyannote-segmentation-model.h"

#include <array>
#include <cmath>
#include <stdexcept>
#include <utility>

#if !defined(__has_include)
#error "Diarization requires a compiler with __has_include for ORT headers"
#endif

#if __has_include("onnxruntime_cxx_api.h")
#include "onnxruntime_cxx_api.h"  // NOLINT
#elif __has_include(<onnxruntime/core/session/onnxruntime_cxx_api.h>)
#include <onnxruntime/core/session/onnxruntime_cxx_api.h>
#else
#error \
    "Diarization requires onnxruntime_cxx_api.h — ORT headers must be on the include path"
#endif

namespace sherpaonnx::diarization {
namespace {

Status RequirePositive(int32_t value, const char* name) {
  if (value <= 0) {
    return Status::Fail(kErrMetadata,
                        std::string(name) + " must be > 0 (got " +
                            std::to_string(value) + ")");
  }
  return Status::Ok();
}

std::string LookupMeta(const Ort::ModelMetadata& meta, OrtAllocator* alloc,
                       const char* key) {
#if ORT_API_VERSION >= 12
  auto value = meta.LookupCustomMetadataMapAllocated(key, alloc);
  return value ? std::string(value.get()) : std::string();
#else
  char* value = meta.LookupCustomMetadataMap(key, alloc);
  std::string ans = value ? value : "";
  if (value) {
    alloc->Free(alloc, value);
  }
  return ans;
#endif
}

bool ReadIntMeta(const Ort::ModelMetadata& meta, OrtAllocator* alloc,
                 const char* key, int32_t* out, std::string* error) {
  const std::string value = LookupMeta(meta, alloc, key);
  if (value.empty()) {
    if (error) {
      *error = std::string("missing required metadata '") + key + "'";
    }
    return false;
  }
  try {
    size_t idx = 0;
    const long parsed = std::stol(value, &idx, 10);
    if (idx != value.size()) {
      if (error) {
        *error =
            std::string("invalid integer metadata '") + key + "': " + value;
      }
      return false;
    }
    *out = static_cast<int32_t>(parsed);
    return true;
  } catch (...) {
    if (error) {
      *error = std::string("invalid integer metadata '") + key + "': " + value;
    }
    return false;
  }
}

}  // namespace

class PyannoteSegmentationModel::Impl {
 public:
  Ort::Env env{ORT_LOGGING_LEVEL_WARNING, "sherpa-onnx-diarization"};
  Ort::SessionOptions session_options;
  std::unique_ptr<Ort::Session> session;
  Ort::AllocatorWithDefaultOptions allocator;
  std::string input_name;
  std::string output_name;
  std::vector<const char*> input_names_ptr;
  std::vector<const char*> output_names_ptr;
};

PyannoteSegmentationModel::PyannoteSegmentationModel() = default;
PyannoteSegmentationModel::~PyannoteSegmentationModel() { Release(); }

bool PyannoteSegmentationModel::isLoaded() const {
  return impl_ != nullptr && impl_->session != nullptr;
}

void PyannoteSegmentationModel::Release() {
  impl_.reset();
  meta_ = {};
  powerset_ = PowersetDecoder{};
}

Status PyannoteSegmentationModel::Load(const PyannoteLoadOptions& options) {
  Release();

  if (options.model_path.empty()) {
    return Status::Fail(kErrInvalidArgument, "segmentation model path is empty");
  }
  float ratio = options.window_shift_ratio;
  if (!(ratio > 0.f) || ratio > 1.f) {
    if (ratio == 0.f) {
      ratio = 0.1f;
    } else {
      return Status::Fail(kErrInvalidArgument,
                          "window_shift_ratio must be in (0, 1]");
    }
  }

  try {
    auto impl = std::make_unique<Impl>();
    impl->session_options.SetIntraOpNumThreads(
        std::max(1, options.num_threads));
    impl->session_options.SetGraphOptimizationLevel(
        GraphOptimizationLevel::ORT_ENABLE_ALL);
    (void)options.provider;

#if defined(_WIN32)
    std::wstring wide(options.model_path.begin(), options.model_path.end());
    impl->session = std::make_unique<Ort::Session>(
        impl->env, wide.c_str(), impl->session_options);
#else
    impl->session = std::make_unique<Ort::Session>(
        impl->env, options.model_path.c_str(), impl->session_options);
#endif

    size_t num_inputs = impl->session->GetInputCount();
    size_t num_outputs = impl->session->GetOutputCount();
    if (num_inputs < 1 || num_outputs < 1) {
      return Status::Fail(kErrModelLoad,
                          "model must have at least one input and output");
    }

#if ORT_API_VERSION >= 12
    {
      auto in = impl->session->GetInputNameAllocated(0, impl->allocator);
      auto out = impl->session->GetOutputNameAllocated(0, impl->allocator);
      impl->input_name = in ? in.get() : "";
      impl->output_name = out ? out.get() : "";
    }
#else
    {
      char* in = impl->session->GetInputName(0, impl->allocator);
      char* out = impl->session->GetOutputName(0, impl->allocator);
      impl->input_name = in ? in : "";
      impl->output_name = out ? out : "";
      if (in) impl->allocator.Free(in);
      if (out) impl->allocator.Free(out);
    }
#endif
    if (impl->input_name.empty() || impl->output_name.empty()) {
      return Status::Fail(kErrModelLoad, "failed to read input/output names");
    }
    impl->input_names_ptr = {impl->input_name.c_str()};
    impl->output_names_ptr = {impl->output_name.c_str()};

    Ort::ModelMetadata meta_data = impl->session->GetModelMetadata();
    OrtAllocator* alloc = impl->allocator;
    std::string err;

    PyannoteMeta meta;
    if (!ReadIntMeta(meta_data, alloc, "sample_rate", &meta.sample_rate,
                     &err) ||
        !ReadIntMeta(meta_data, alloc, "window_size", &meta.window_size,
                     &err) ||
        !ReadIntMeta(meta_data, alloc, "receptive_field_size",
                     &meta.receptive_field_size, &err) ||
        !ReadIntMeta(meta_data, alloc, "receptive_field_shift",
                     &meta.receptive_field_shift, &err) ||
        !ReadIntMeta(meta_data, alloc, "num_speakers", &meta.num_speakers,
                     &err) ||
        !ReadIntMeta(meta_data, alloc, "powerset_max_classes",
                     &meta.powerset_max_classes, &err) ||
        !ReadIntMeta(meta_data, alloc, "num_classes", &meta.num_classes,
                     &err)) {
      return Status::Fail(kErrMetadata, err);
    }

    if (auto st = RequirePositive(meta.sample_rate, "sample_rate"); !st.ok)
      return st;
    if (auto st = RequirePositive(meta.window_size, "window_size"); !st.ok)
      return st;
    if (auto st =
            RequirePositive(meta.receptive_field_size, "receptive_field_size");
        !st.ok)
      return st;
    if (auto st = RequirePositive(meta.receptive_field_shift,
                                  "receptive_field_shift");
        !st.ok)
      return st;
    if (auto st = RequirePositive(meta.num_speakers, "num_speakers"); !st.ok)
      return st;
    if (meta.powerset_max_classes < 0) {
      return Status::Fail(kErrMetadata, "powerset_max_classes must be >= 0");
    }
    if (auto st = RequirePositive(meta.num_classes, "num_classes"); !st.ok)
      return st;

    const double window_shift_d =
        static_cast<double>(ratio) * static_cast<double>(meta.window_size);
    if (std::isnan(window_shift_d) || window_shift_d < 1.0) {
      meta.window_shift = 1;
    } else if (window_shift_d > meta.window_size) {
      meta.window_shift = meta.window_size;
    } else {
      meta.window_shift = static_cast<int32_t>(std::lround(window_shift_d));
    }

    PowersetDecoder decoder;
    Status pow_st = decoder.Init(meta.num_speakers, meta.powerset_max_classes,
                                 meta.num_classes);
    if (!pow_st.ok) {
      return pow_st;
    }

    impl_ = std::move(impl);
    meta_ = meta;
    powerset_ = std::move(decoder);
    return Status::Ok();
  } catch (const Ort::Exception& e) {
    Release();
    return Status::Fail(kErrModelLoad,
                        std::string("ORT exception: ") + e.what());
  } catch (const std::exception& e) {
    Release();
    return Status::Fail(kErrModelLoad, std::string("exception: ") + e.what());
  }
}

Status PyannoteSegmentationModel::ForwardWindow(
    const float* samples, int32_t num_samples, std::vector<float>* out_logits,
    int32_t* out_num_frames) const {
  if (!isLoaded()) {
    return Status::Fail(kErrNotInitialized, "segmentation model not loaded");
  }
  if (samples == nullptr || out_logits == nullptr || out_num_frames == nullptr) {
    return Status::Fail(kErrInvalidArgument, "null pointer");
  }
  if (num_samples != meta_.window_size) {
    return Status::Fail(kErrInvalidArgument,
                        "ForwardWindow expects exactly window_size samples");
  }

  try {
    auto memory_info =
        Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
    std::array<int64_t, 3> shape = {1, 1, meta_.window_size};
    Ort::Value input = Ort::Value::CreateTensor<float>(
        memory_info, const_cast<float*>(samples),
        static_cast<size_t>(num_samples), shape.data(), shape.size());

    auto outputs = impl_->session->Run(
        Ort::RunOptions{nullptr}, impl_->input_names_ptr.data(), &input, 1,
        impl_->output_names_ptr.data(), 1);

    if (outputs.empty()) {
      return Status::Fail(kErrInference, "empty ORT output");
    }

    auto info = outputs[0].GetTensorTypeAndShapeInfo();
    auto out_shape = info.GetShape();
    int32_t num_frames = 0;
    int32_t num_classes = 0;
    if (out_shape.size() == 3) {
      num_frames = static_cast<int32_t>(out_shape[1]);
      num_classes = static_cast<int32_t>(out_shape[2]);
    } else if (out_shape.size() == 2) {
      num_frames = static_cast<int32_t>(out_shape[0]);
      num_classes = static_cast<int32_t>(out_shape[1]);
    } else {
      return Status::Fail(kErrInference, "unexpected output rank");
    }
    if (num_frames <= 0 || num_classes != meta_.num_classes) {
      return Status::Fail(
          kErrInference,
          "output shape mismatch: frames=" + std::to_string(num_frames) +
              " classes=" + std::to_string(num_classes));
    }

    const float* data = outputs[0].GetTensorData<float>();
    const size_t count =
        static_cast<size_t>(num_frames) * static_cast<size_t>(num_classes);
    out_logits->assign(data, data + count);
    *out_num_frames = num_frames;
    return Status::Ok();
  } catch (const Ort::Exception& e) {
    return Status::Fail(kErrInference,
                        std::string("ORT Run failed: ") + e.what());
  } catch (const std::exception& e) {
    return Status::Fail(kErrInference,
                        std::string("inference exception: ") + e.what());
  }
}

}  // namespace sherpaonnx::diarization
