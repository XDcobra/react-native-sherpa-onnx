#include "DoctrBackend.h"

#include "DoctrDbPostprocess.h"
#include "DoctrImageOps.h"
#include "DoctrRecDecode.h"
#include "OcrOrtEnv.h"
#include "ort/ApplyOrtProvider.h"

#include <onnxruntime_cxx_api.h>

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <stdexcept>
#include <vector>

namespace fs = std::filesystem;

#ifndef OCR_LOG_TAG
#define OCR_LOG_TAG "SherpaOnnx:ocr"
#endif

#if defined(__ANDROID__)
#include <android/log.h>
#define OCR_LOGI(...) __android_log_print(ANDROID_LOG_INFO, OCR_LOG_TAG, __VA_ARGS__)
#define OCR_LOGW(...) __android_log_print(ANDROID_LOG_WARN, OCR_LOG_TAG, __VA_ARGS__)
#else
#include <cstdio>
#define OCR_LOGI(...)                               \
  do {                                              \
    std::fprintf(stderr, "[SherpaOnnx:ocr] ");      \
    std::fprintf(stderr, __VA_ARGS__);              \
    std::fprintf(stderr, "\n");                     \
  } while (0)
#define OCR_LOGW(...) OCR_LOGI(__VA_ARGS__)
#endif

namespace sherpa_onnx {
namespace ocr {
namespace doctr {
namespace {

std::string JoinPath(const std::string& dir, const std::string& file) {
  fs::path p(dir);
  p /= file;
  return p.string();
}

std::string FirstInputName(Ort::Session& session) {
  Ort::AllocatorWithDefaultOptions alloc;
  return session.GetInputNameAllocated(0, alloc).get();
}

std::string FirstOutputName(Ort::Session& session) {
  Ort::AllocatorWithDefaultOptions alloc;
  return session.GetOutputNameAllocated(0, alloc).get();
}

}  // namespace

DoctrBackend::DoctrBackend() = default;

DoctrBackend::~DoctrBackend() {
  Release();
}

void DoctrBackend::Load(const std::string& model_dir, const OcrLoadOptions& options) {
  Release();
  options_ = options;

  const std::string det_path =
      OcrResolvePath(options.path_det, model_dir, "det.onnx");
  const std::string rec_path =
      OcrResolvePath(options.path_rec, model_dir, "rec.onnx");
  const std::string manifest_path =
      OcrResolvePath(options.path_manifest, model_dir, "ocr_manifest.json");

  if (!fs::exists(det_path) || !fs::exists(rec_path) || !fs::exists(manifest_path)) {
    throw std::runtime_error(
        "DoctrBackend: need det, rec, and manifest (or path overrides)");
  }

  manifest_ = ParseDoctrManifestFile(manifest_path);
  OCR_LOGI("doctr manifest: det=%s (%dx%d) rec=%s (%dx%d) vocab=%zu",
           manifest_.det_arch.c_str(), manifest_.det_h, manifest_.det_w,
           manifest_.rec_arch.c_str(), manifest_.rec_h, manifest_.rec_w,
           manifest_.rec_vocab.size());

  Ort::Env& env = SharedOrtEnv();
  session_options_ = std::make_unique<Ort::SessionOptions>();
  session_options_->SetIntraOpNumThreads(std::max(1, options_.num_threads));
  session_options_->SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
  ApplyOrtProvider(*session_options_, options_.provider);

  det_session_ =
      std::make_unique<Ort::Session>(env, det_path.c_str(), *session_options_);
  rec_session_ =
      std::make_unique<Ort::Session>(env, rec_path.c_str(), *session_options_);
  det_input_name_ = FirstInputName(*det_session_);
  det_output_name_ = FirstOutputName(*det_session_);
  rec_input_name_ = FirstInputName(*rec_session_);
  rec_output_name_ = FirstOutputName(*rec_session_);

  loaded_ = true;
}

void DoctrBackend::Release() {
  loaded_ = false;
  det_session_.reset();
  rec_session_.reset();
  session_options_.reset();
  manifest_ = DoctrManifest{};
}

OcrResult DoctrBackend::Recognize(const OcrFrameView& frame,
                                  const OcrRecognizeContext& ctx) {
  if (!loaded_) {
    throw std::runtime_error("DoctrBackend::Recognize called before Load");
  }
  if (frame.rgb == nullptr || frame.width <= 0 || frame.height <= 0) {
    throw std::invalid_argument("DoctrBackend::Recognize: invalid frame");
  }

  const int det_h = manifest_.det_h;
  const int det_w = manifest_.det_w;
  RgbImage resized;
  std::vector<float> det_input;
  ctx.RunPhase(kOcrPhasePreprocess, [&] {
    resized = ResizeRgb(frame.rgb, frame.width, frame.height, det_w, det_h);
    det_input = SubtractMeanNormalizeRgb(resized.rgb.data(), resized.width, resized.height,
                                         manifest_.det_mean.data(), manifest_.det_std.data());
  });

  std::array<int64_t, 4> det_shape{
      1, 3, static_cast<int64_t>(det_h), static_cast<int64_t>(det_w)};
  Ort::MemoryInfo mem =
      Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);

  std::vector<Ort::Value> det_outs;
  int pred_h = 0;
  int pred_w = 0;
  const float* logits = nullptr;
  ctx.RunPhase(kOcrPhaseDetect, [&] {
    Ort::Value det_tensor = Ort::Value::CreateTensor<float>(
        mem, det_input.data(), det_input.size(), det_shape.data(), det_shape.size());
    const char* det_in[] = {det_input_name_.c_str()};
    const char* det_out[] = {det_output_name_.c_str()};
    det_outs = det_session_->Run(Ort::RunOptions{nullptr}, det_in, &det_tensor, 1, det_out, 1);
    auto det_info = det_outs[0].GetTensorTypeAndShapeInfo();
    auto det_dims = det_info.GetShape();
    if (det_dims.size() == 4) {
      pred_h = static_cast<int>(det_dims[2]);
      pred_w = static_cast<int>(det_dims[3]);
    } else if (det_dims.size() == 3) {
      pred_h = static_cast<int>(det_dims[1]);
      pred_w = static_cast<int>(det_dims[2]);
    } else {
      throw std::runtime_error("Unexpected det output rank");
    }
    logits = det_outs[0].GetTensorData<float>();
  });

  // doctr det outputs logits (not probabilities); sigmoid + postprocess maps
  // boxes from det input space back to source image coords.
  // doctr DB models produce lower sigmoid scores than ppocr; use adapted defaults
  // when the caller passes the ppocr-tuned defaults.
  float box_thresh = options_.det_box_thresh;
  float score_thresh = options_.det_box_score_thresh;
  if (box_thresh >= 0.3f) box_thresh = 0.15f;
  if (score_thresh >= 0.5f) score_thresh = 0.15f;
  auto boxes = DoctrDbPostprocess(
      logits, pred_h, pred_w,
      frame.width, frame.height,
      box_thresh, score_thresh,
      options_.det_unclip_ratio);

  // --- Recognition per box ---
  OcrResult result;
  int utf16_cursor = 0;
  const int box_n = static_cast<int>(boxes.size());
  if (box_n == 0) {
    ctx.Report(kOcrPhaseRecognize, 1, 1);
  }
  for (size_t bi = 0; bi < boxes.size(); ++bi) {
    ctx.ThrowIfCancelled();
    ctx.Report(kOcrPhaseRecognize, static_cast<int>(bi), box_n);
    const auto& box = boxes[bi];
    const float bw = std::hypot(box.quad[2] - box.quad[0], box.quad[3] - box.quad[1]);
    const float bh = std::hypot(box.quad[6] - box.quad[0], box.quad[7] - box.quad[1]);
    int crop_w = std::max(8, static_cast<int>(std::round(bw)));
    int crop_h = std::max(8, static_cast<int>(std::round(bh)));
    RgbImage crop = WarpQuadRgb(
        frame.rgb, frame.width, frame.height, box.quad, crop_w, crop_h);

    // Rotate 90 CW for tall crops
    if (static_cast<float>(crop.height) >= static_cast<float>(crop.width) * 1.5f) {
      RgbImage rot;
      rot.width = crop.height;
      rot.height = crop.width;
      rot.rgb.resize(static_cast<size_t>(rot.width) * rot.height * 3);
      for (int y = 0; y < crop.height; ++y) {
        for (int x = 0; x < crop.width; ++x) {
          const uint8_t* s = &crop.rgb[(y * crop.width + x) * 3];
          uint8_t* d = &rot.rgb[(x * rot.width + (rot.width - 1 - y)) * 3];
          d[0] = s[0]; d[1] = s[1]; d[2] = s[2];
        }
      }
      crop = std::move(rot);
    }

    // Fixed rec input size from manifest
    const int rec_h = manifest_.rec_h;
    const int rec_w = manifest_.rec_w;
    RgbImage rec_img = AdjustRecImage(crop, rec_h, rec_w);
    auto rec_in = SubtractMeanNormalizeRgb(
        rec_img.rgb.data(), rec_img.width, rec_img.height,
        manifest_.rec_mean.data(), manifest_.rec_std.data());

    std::array<int64_t, 4> rec_shape{
        1, 3, static_cast<int64_t>(rec_h), static_cast<int64_t>(rec_w)};
    Ort::Value rec_tensor = Ort::Value::CreateTensor<float>(
        mem, rec_in.data(), rec_in.size(), rec_shape.data(), rec_shape.size());
    const char* rec_in_n[] = {rec_input_name_.c_str()};
    const char* rec_out_n[] = {rec_output_name_.c_str()};
    auto rec_outs = rec_session_->Run(
        Ort::RunOptions{nullptr}, rec_in_n, &rec_tensor, 1, rec_out_n, 1);
    auto rec_dims = rec_outs[0].GetTensorTypeAndShapeInfo().GetShape();
    int T = 0;
    int C = 0;
    const float* rec_logits = rec_outs[0].GetTensorData<float>();
    if (rec_dims.size() == 3) {
      T = static_cast<int>(rec_dims[1]);
      C = static_cast<int>(rec_dims[2]);
    } else if (rec_dims.size() == 2) {
      T = static_cast<int>(rec_dims[0]);
      C = static_cast<int>(rec_dims[1]);
    } else {
      throw std::runtime_error("Unexpected rec output rank");
    }

    std::string line;
    float conf = 0.f;
    if (manifest_.IsParseq()) {
      auto [txt, c] = ParseqDecode(rec_logits, T, C, manifest_.rec_vocab);
      line = std::move(txt);
      conf = c;
    } else {
      auto [txt, c] = CtcBlankLastDecode(rec_logits, T, C, manifest_.rec_vocab);
      line = std::move(txt);
      conf = c;
    }

    if (line.empty()) continue;

    if (!result.text_utf8.empty()) {
      result.text_utf8.push_back('\n');
      utf16_cursor += 1;
    }
    const int start = utf16_cursor;
    const int line_units = Utf8ToUtf16Length(line);
    result.text_utf8 += line;
    utf16_cursor += line_units;

    OcrSpan span;
    span.utf16_start = start;
    span.utf16_end = utf16_cursor;
    span.confidence = conf * box.score;
    span.frame_index = frame.frame_index;
    span.level = OcrSpanLevel::kLine;
    for (int i = 0; i < 8; ++i) {
      span.quad.xy[i] = box.quad[i];
    }
    result.spans.push_back(span);
  }
  if (box_n > 0) {
    ctx.Report(kOcrPhaseRecognize, box_n, box_n);
  }

  return result;
}

}  // namespace doctr
}  // namespace ocr
}  // namespace sherpa_onnx
