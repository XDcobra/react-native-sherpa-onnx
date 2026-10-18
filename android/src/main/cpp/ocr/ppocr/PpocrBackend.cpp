#include "PpocrBackend.h"

#include "PpocrCtcDecoder.h"
#include "PpocrDbPostprocess.h"
#include "PpocrImageOps.h"

#include <onnxruntime_cxx_api.h>

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <numeric>
#include <stdexcept>
#include <utility>

namespace fs = std::filesystem;

namespace sherpa_onnx {
namespace ocr {
namespace ppocr {
namespace {

static const float kDetMean[3] = {0.485f, 0.456f, 0.406f};
static const float kDetNorm[3] = {0.229f, 0.224f, 0.225f};
// PP-OCR rec/cls often use mean=0.5 norm=0.5
static const float kRecMean[3] = {0.5f, 0.5f, 0.5f};
static const float kRecNorm[3] = {0.5f, 0.5f, 0.5f};

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

PpocrBackend::PpocrBackend() = default;

PpocrBackend::~PpocrBackend() {
  Release();
}

void PpocrBackend::Load(const std::string& model_dir, const OcrLoadOptions& options) {
  Release();
  options_ = options;

  const std::string det_path =
      OcrResolvePath(options.path_det, model_dir, "det.onnx");
  const std::string rec_path =
      OcrResolvePath(options.path_rec, model_dir, "rec.onnx");
  const std::string cls_path =
      OcrResolvePath(options.path_cls, model_dir, "cls.onnx");
  const std::string yml_path =
      OcrResolvePath(options.path_rec_dict, model_dir, "rec_inference.yml");

  if (!fs::exists(det_path) || !fs::exists(rec_path) || !fs::exists(yml_path)) {
    throw std::runtime_error(
        "PpocrBackend: need det, rec, and rec_dict (det.onnx/rec.onnx/rec_inference.yml or path overrides)");
  }

  dict_ = LoadCharacterDictFromYml(yml_path);

  env_ = std::make_unique<Ort::Env>(ORT_LOGGING_LEVEL_WARNING, "sherpa-onnx-ocr");
  session_options_ = std::make_unique<Ort::SessionOptions>();
  session_options_->SetIntraOpNumThreads(std::max(1, options_.num_threads));
  session_options_->SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);

  // Provider: v1 defaults to CPU. Non-empty non-cpu ids are accepted for forward
  // compatibility but currently fall back to CPU (mobile ORT builds vary).
  const std::string provider =
      options_.provider.empty() ? "cpu" : options_.provider;
  if (provider != "cpu") {
    // Keep CPU sessions; EP plugins are not wired for OCR in this build.
    // Callers may still pass provider for parity with other features.
  }

  det_session_ =
      std::make_unique<Ort::Session>(*env_, det_path.c_str(), *session_options_);
  rec_session_ =
      std::make_unique<Ort::Session>(*env_, rec_path.c_str(), *session_options_);
  det_input_name_ = FirstInputName(*det_session_);
  det_output_name_ = FirstOutputName(*det_session_);
  rec_input_name_ = FirstInputName(*rec_session_);
  rec_output_name_ = FirstOutputName(*rec_session_);

  has_cls_ = options_.use_orientation_cls && fs::exists(cls_path);
  if (has_cls_) {
    cls_session_ =
        std::make_unique<Ort::Session>(*env_, cls_path.c_str(), *session_options_);
    cls_input_name_ = FirstInputName(*cls_session_);
    cls_output_name_ = FirstOutputName(*cls_session_);
  }

  loaded_ = true;
}

void PpocrBackend::Release() {
  loaded_ = false;
  has_cls_ = false;
  dict_.clear();
  det_session_.reset();
  rec_session_.reset();
  cls_session_.reset();
  session_options_.reset();
  env_.reset();
}

OcrResult PpocrBackend::Recognize(const OcrFrameView& frame) {
  if (!loaded_) {
    throw std::runtime_error("PpocrBackend::Recognize called before Load");
  }
  if (frame.rgb == nullptr || frame.width <= 0 || frame.height <= 0) {
    throw std::invalid_argument("PpocrBackend::Recognize: invalid frame");
  }

  const ScaleParam scale =
      MakeDetScale(frame.width, frame.height, options_.max_side_len);
  RgbImage resized =
      ResizeRgb(frame.rgb, frame.width, frame.height, scale.dst_w, scale.dst_h);
  auto det_input = SubtractMeanNormalize(
      resized.rgb.data(), resized.width, resized.height, kDetMean, kDetNorm);

  std::array<int64_t, 4> det_shape{
      1, 3, static_cast<int64_t>(resized.height), static_cast<int64_t>(resized.width)};
  Ort::MemoryInfo mem =
      Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
  Ort::Value det_tensor = Ort::Value::CreateTensor<float>(
      mem, det_input.data(), det_input.size(), det_shape.data(), det_shape.size());

  const char* det_in[] = {det_input_name_.c_str()};
  const char* det_out[] = {det_output_name_.c_str()};
  auto det_outs = det_session_->Run(
      Ort::RunOptions{nullptr}, det_in, &det_tensor, 1, det_out, 1);
  auto det_info = det_outs[0].GetTensorTypeAndShapeInfo();
  auto det_dims = det_info.GetShape();
  // Expect NCHW probability map
  int pred_h = 0;
  int pred_w = 0;
  if (det_dims.size() == 4) {
    pred_h = static_cast<int>(det_dims[2]);
    pred_w = static_cast<int>(det_dims[3]);
  } else if (det_dims.size() == 3) {
    pred_h = static_cast<int>(det_dims[1]);
    pred_w = static_cast<int>(det_dims[2]);
  } else {
    throw std::runtime_error("Unexpected det output rank");
  }
  const float* pred = det_outs[0].GetTensorData<float>();

  ScaleParam pred_scale = scale;
  // If network downsamples, ratios still map via dst size used for input;
  // boxes are computed in pred space then divided by ratio relative to src.
  // When pred size != dst size, adjust ratios.
  if (pred_w > 0 && pred_h > 0 &&
      (pred_w != scale.dst_w || pred_h != scale.dst_h)) {
    pred_scale.ratio_w = static_cast<float>(pred_w) / static_cast<float>(scale.src_w);
    pred_scale.ratio_h = static_cast<float>(pred_h) / static_cast<float>(scale.src_h);
    pred_scale.dst_w = pred_w;
    pred_scale.dst_h = pred_h;
  }

  auto boxes = DbPostprocess(
      pred,
      pred_h,
      pred_w,
      pred_scale,
      options_.det_box_thresh,
      options_.det_box_score_thresh,
      options_.det_unclip_ratio);

  OcrResult result;
  int utf16_cursor = 0;
  for (size_t bi = 0; bi < boxes.size(); ++bi) {
    const auto& box = boxes[bi];
    const float bw = std::hypot(box.quad[2] - box.quad[0], box.quad[3] - box.quad[1]);
    const float bh = std::hypot(box.quad[6] - box.quad[0], box.quad[7] - box.quad[1]);
    int crop_w = std::max(8, static_cast<int>(std::round(bw)));
    int crop_h = std::max(8, static_cast<int>(std::round(bh)));
    RgbImage crop = WarpQuadRgb(
        frame.rgb, frame.width, frame.height, box.quad, crop_w, crop_h);
    if (static_cast<float>(crop.height) >= static_cast<float>(crop.width) * 1.5f) {
      // rotate 90 CW for tall crops
      RgbImage rot;
      rot.width = crop.height;
      rot.height = crop.width;
      rot.rgb.resize(static_cast<size_t>(rot.width) * rot.height * 3);
      for (int y = 0; y < crop.height; ++y) {
        for (int x = 0; x < crop.width; ++x) {
          const uint8_t* s = &crop.rgb[(y * crop.width + x) * 3];
          uint8_t* d = &rot.rgb[(x * rot.width + (rot.width - 1 - y)) * 3];
          d[0] = s[0];
          d[1] = s[1];
          d[2] = s[2];
        }
      }
      crop = std::move(rot);
    }

    if (has_cls_ && cls_session_) {
      // PP-LCNet_x0_25_textline_ori_onnx expects fixed 80x160 (not classic 48x192).
      constexpr int kClsH = 80;
      constexpr int kClsW = 160;
      RgbImage cls_img = AdjustRecImage(crop, kClsH, kClsW);
      auto cls_in = SubtractMeanNormalize(
          cls_img.rgb.data(), cls_img.width, cls_img.height, kDetMean, kDetNorm);
      std::array<int64_t, 4> cls_shape{1, 3, kClsH, kClsW};
      Ort::Value cls_tensor = Ort::Value::CreateTensor<float>(
          mem, cls_in.data(), cls_in.size(), cls_shape.data(), cls_shape.size());
      const char* cls_in_n[] = {cls_input_name_.c_str()};
      const char* cls_out_n[] = {cls_output_name_.c_str()};
      auto cls_outs = cls_session_->Run(
          Ort::RunOptions{nullptr}, cls_in_n, &cls_tensor, 1, cls_out_n, 1);
      const float* cls_data = cls_outs[0].GetTensorData<float>();
      auto cls_dims = cls_outs[0].GetTensorTypeAndShapeInfo().GetShape();
      int ncls = 2;
      if (!cls_dims.empty()) {
        ncls = static_cast<int>(cls_dims.back());
      }
      int best = 0;
      for (int i = 1; i < ncls; ++i) {
        if (cls_data[i] > cls_data[best]) {
          best = i;
        }
      }
      // PP-LCNet textline ori: class 1 = 180°. Require a clear margin so
      // upright Latin lines are not flipped by a weak classifier score.
      const float best_score = cls_data[best];
      const float other = ncls > 1 ? cls_data[1 - best] : 0.f;
      if (best == 1 && best_score >= 0.9f && (best_score - other) >= 0.35f) {
        RgbImage flipped = crop;
        const int n = crop.width * crop.height;
        for (int i = 0; i < n; ++i) {
          const int j = n - 1 - i;
          flipped.rgb[i * 3 + 0] = crop.rgb[j * 3 + 0];
          flipped.rgb[i * 3 + 1] = crop.rgb[j * 3 + 1];
          flipped.rgb[i * 3 + 2] = crop.rgb[j * 3 + 2];
        }
        crop = std::move(flipped);
      }
    }

    constexpr int kRecH = 48;
    constexpr int kRecMaxW = 3200;  // matches pack dynamic_shapes upper bound
    const float rec_scale =
        static_cast<float>(kRecH) / static_cast<float>(std::max(1, crop.height));
    int rec_w = std::max(
        32, static_cast<int>(std::round(static_cast<float>(crop.width) * rec_scale)));
    rec_w = std::min(rec_w, kRecMaxW);
    // keep width multiple of 8 for ORT friendliness
    rec_w = std::max(32, (rec_w + 7) / 8 * 8);
    RgbImage rec_img = AdjustRecImage(crop, kRecH, rec_w);
    auto rec_in = SubtractMeanNormalize(
        rec_img.rgb.data(), rec_img.width, rec_img.height, kRecMean, kRecNorm);
    std::array<int64_t, 4> rec_shape{
        1, 3, kRecH, static_cast<int64_t>(rec_img.width)};
    Ort::Value rec_tensor = Ort::Value::CreateTensor<float>(
        mem, rec_in.data(), rec_in.size(), rec_shape.data(), rec_shape.size());
    const char* rec_in_n[] = {rec_input_name_.c_str()};
    const char* rec_out_n[] = {rec_output_name_.c_str()};
    auto rec_outs = rec_session_->Run(
        Ort::RunOptions{nullptr}, rec_in_n, &rec_tensor, 1, rec_out_n, 1);
    auto rec_dims = rec_outs[0].GetTensorTypeAndShapeInfo().GetShape();
    // Common: [1, T, C] or [T, C]
    int T = 0;
    int C = 0;
    const float* logits = rec_outs[0].GetTensorData<float>();
    if (rec_dims.size() == 3) {
      T = static_cast<int>(rec_dims[1]);
      C = static_cast<int>(rec_dims[2]);
    } else if (rec_dims.size() == 2) {
      T = static_cast<int>(rec_dims[0]);
      C = static_cast<int>(rec_dims[1]);
    } else {
      throw std::runtime_error("Unexpected rec output rank");
    }

    auto [line, conf] = CtcGreedyDecode(logits, T, C, dict_);
    if (line.empty()) {
      continue;
    }
    if (!result.text_utf8.empty()) {
      result.text_utf8.push_back('\n');
      utf16_cursor += 1;  // '\n' is one UTF-16 unit
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

  return result;
}

}  // namespace ppocr
}  // namespace ocr
}  // namespace sherpa_onnx
