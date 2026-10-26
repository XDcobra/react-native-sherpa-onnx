#include "NemotronParseBackend.h"

#include "NemotronParseImageOps.h"
#include "NemotronParseLog.h"
#include "NemotronParseMarkup.h"
#include "NemotronParseNavit.h"
#include "NemotronParseNpy.h"
#include "OcrOrtEnv.h"
#include "ort/ApplyOrtProvider.h"

#include <onnxruntime_cxx_api.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <unordered_set>
#include <utility>
#include <vector>

namespace fs = std::filesystem;

namespace sherpa_onnx {
namespace ocr {
namespace nemotron_parse {
namespace {

constexpr int kBosId = 0;
constexpr int kEosId = 2;
constexpr int kDefaultMaxNewTokens = 8192;
constexpr int kMaxPositions = 16384;
constexpr int kNumLayers = 10;
constexpr int kKvHeads = 8;
constexpr int kHeadDim = 64;
constexpr int kVocab = 72512;
constexpr int kDecoderWidth = 1024;
constexpr int kVisionWidth = 1152;
constexpr int kPatchIn = 768;
constexpr float kRepetitionPenalty = 1.1f;
constexpr const char* kPrompt =
    "</s><s><predict_bbox><predict_classes><output_markdown><predict_text_in_pic>";

void RequireNonEmptyFile(const std::string& path) {
  std::error_code ec;
  if (!fs::is_regular_file(path, ec) || ec) {
    throw std::runtime_error("NemotronParseBackend: missing " + path);
  }
  if (fs::file_size(path, ec) == 0 || ec) {
    throw std::runtime_error("NemotronParseBackend: empty " + path);
  }
}

std::unordered_set<std::string> IoNames(Ort::Session& session, bool input) {
  Ort::AllocatorWithDefaultOptions alloc;
  const size_t count = input ? session.GetInputCount() : session.GetOutputCount();
  std::unordered_set<std::string> names;
  for (size_t i = 0; i < count; ++i) {
    const auto owned = input ? session.GetInputNameAllocated(i, alloc)
                             : session.GetOutputNameAllocated(i, alloc);
    names.emplace(owned.get());
  }
  return names;
}

void RequireName(const std::unordered_set<std::string>& names, const std::string& name,
                 const char* what) {
  if (names.find(name) == names.end()) {
    throw std::runtime_error(std::string("NemotronParseBackend: ") + what + " missing " +
                             name);
  }
}

int32_t Argmax(const float* row, int n) {
  if (n <= 0 || row == nullptr) {
    throw std::runtime_error("NemotronParseBackend: empty logits row");
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

int32_t ArgmaxWithPenalty(const float* row, int vocab, const std::vector<int32_t>& ids,
                          float penalty) {
  if (penalty == 1.f) return Argmax(row, vocab);
  std::vector<float> scores(row, row + vocab);
  std::vector<char> seen(static_cast<size_t>(vocab), 0);
  for (int32_t id : ids) {
    if (id < 0 || id >= vocab || seen[static_cast<size_t>(id)]) continue;
    seen[static_cast<size_t>(id)] = 1;
    float& v = scores[static_cast<size_t>(id)];
    if (v < 0.f) {
      v *= penalty;
    } else {
      v /= penalty;
    }
  }
  return Argmax(scores.data(), vocab);
}

int ResolveMaxNewTokens(int requested, int prefix_len) {
  int cap = requested <= 0 ? kDefaultMaxNewTokens : requested;
  if (cap > kDefaultMaxNewTokens) cap = kDefaultMaxNewTokens;
  if (prefix_len + cap > kMaxPositions) {
    const int lowered = std::max(0, kMaxPositions - prefix_len);
    OCR_LOGI("nemotron_parse clamp max_new_tokens %d -> %d prefix=%d max_pos=%d", cap,
             lowered, prefix_len, kMaxPositions);
    cap = lowered;
  }
  return cap;
}

}  // namespace

NemotronParseBackend::NemotronParseBackend() = default;
NemotronParseBackend::~NemotronParseBackend() { Release(); }

void NemotronParseBackend::Release() {
  loaded_ = false;
  decoder_input_names_.clear();
  decoder_output_names_.clear();
  patch_session_.reset();
  vision_session_.reset();
  embed_session_.reset();
  decoder_session_.reset();
  session_options_.reset();
  tokenizer_ = NemotronParseTokenizer{};
  manifest_ = NemotronParseManifest{};
  pos_embed_.clear();
}

void NemotronParseBackend::Load(const std::string& model_dir, const OcrLoadOptions& options) {
  Release();
  options_ = options;

  const std::string patch_path =
      OcrResolvePath(options.path_patch_embed, model_dir, "patch_embed.onnx");
  const std::string patch_data =
      OcrResolvePath(options.path_patch_embed_data, model_dir, "patch_embed.onnx_data");
  const std::string pos_path = OcrResolvePath(options.path_pos_embed, model_dir, "pos_embed.npy");
  const std::string vision_path =
      OcrResolvePath(options.path_vision_encoder, model_dir, "vision_encoder.onnx");
  const std::string vision_data = OcrResolvePath(options.path_vision_encoder_data, model_dir,
                                                 "vision_encoder.onnx_data");
  const std::string embed_path =
      OcrResolvePath(options.path_embed_tokens, model_dir, "embed_tokens.onnx");
  const std::string embed_data =
      OcrResolvePath(options.path_embed_tokens_data, model_dir, "embed_tokens.onnx_data");
  const std::string decoder_path =
      OcrResolvePath(options.path_decoder, model_dir, "decoder_model_merged.onnx");
  const std::string decoder_data =
      OcrResolvePath(options.path_decoder_data, model_dir, "decoder_model_merged.onnx_data");
  const std::string tokenizer_path =
      OcrResolvePath(options.path_tokenizer, model_dir, "tokenizer.json");
  const std::string manifest_path =
      OcrResolvePath(options.path_manifest, model_dir, "ocr_manifest.json");

  for (const auto& path : {patch_path, pos_path, vision_path, vision_data, embed_path, embed_data,
                           decoder_path, decoder_data, tokenizer_path, manifest_path}) {
    RequireNonEmptyFile(path);
  }
  std::error_code ec;
  if (fs::is_regular_file(patch_data, ec) && !ec) {
    if (fs::file_size(patch_data, ec) == 0 || ec) {
      throw std::runtime_error("NemotronParseBackend: empty " + patch_data);
    }
  }

  manifest_ = ParseNemotronParseManifestFile(manifest_path);
  tokenizer_ = NemotronParseTokenizer::Load(tokenizer_path);
  if (tokenizer_.TokenId("<s>") != kBosId || tokenizer_.TokenId("</s>") != kEosId) {
    throw std::runtime_error("NemotronParseBackend: BOS/EOS ids do not match");
  }
  pos_embed_ = LoadPosEmbedNpy(pos_path);
  OCR_LOGI("nemotron_parse pos_embed n=%zu dtype_pack=%s", pos_embed_.size(),
           manifest_.onnx_dtype.c_str());

  Ort::Env& env = SharedOrtEnv();
  session_options_ = std::make_unique<Ort::SessionOptions>();
  session_options_->SetIntraOpNumThreads(std::max(1, options_.num_threads));
  session_options_->SetInterOpNumThreads(1);
  session_options_->SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_EXTENDED);
  ApplyOrtProvider(*session_options_, options_.provider);

  const auto open_session = [&](const std::string& path, const char* label) {
    const auto t0 = std::chrono::steady_clock::now();
    auto session = std::make_unique<Ort::Session>(env, path.c_str(), *session_options_);
    const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                        std::chrono::steady_clock::now() - t0)
                        .count();
    OCR_LOGI("nemotron_parse session %s %lld ms", label, static_cast<long long>(ms));
    return session;
  };
  patch_session_ = open_session(patch_path, "patch_embed.onnx");
  vision_session_ = open_session(vision_path, "vision_encoder.onnx");
  embed_session_ = open_session(embed_path, "embed_tokens.onnx");
  decoder_session_ = open_session(decoder_path, "decoder_model_merged.onnx");

  RequireName(IoNames(*patch_session_, true), "patches", "patch");
  RequireName(IoNames(*patch_session_, false), "patch_tokens", "patch");
  RequireName(IoNames(*vision_session_, true), "patch_tokens", "vision");
  RequireName(IoNames(*vision_session_, false), "vision", "vision");
  RequireName(IoNames(*vision_session_, false), "visual_mask", "vision");
  RequireName(IoNames(*embed_session_, true), "input_ids", "embed");
  RequireName(IoNames(*embed_session_, false), "inputs_embeds", "embed");

  decoder_input_names_.push_back("inputs_embeds");
  decoder_input_names_.push_back("attention_mask");
  decoder_output_names_.push_back("logits");
  for (int layer = 0; layer < kNumLayers; ++layer) {
    decoder_input_names_.push_back("past_key_" + std::to_string(layer));
    decoder_input_names_.push_back("past_value_" + std::to_string(layer));
    decoder_output_names_.push_back("present_key_" + std::to_string(layer));
    decoder_output_names_.push_back("present_value_" + std::to_string(layer));
  }
  const auto dec_in = IoNames(*decoder_session_, true);
  const auto dec_out = IoNames(*decoder_session_, false);
  for (const auto& name : decoder_input_names_) RequireName(dec_in, name, "decoder");
  for (const auto& name : decoder_output_names_) RequireName(dec_out, name, "decoder");

  loaded_ = true;
  OCR_LOGI("nemotron_parse loaded layers=%d kv=%d dim=%d vocab=%d", kNumLayers, kKvHeads,
           kHeadDim, kVocab);
}

OcrResult NemotronParseBackend::Recognize(const OcrFrameView& frame,
                                          const OcrRecognizeContext& ctx) {
  if (!loaded_) throw std::runtime_error("NemotronParseBackend::Recognize called before Load");
  if (frame.rgb == nullptr || frame.width <= 0 || frame.height <= 0) {
    throw std::invalid_argument("NemotronParseBackend: invalid frame");
  }

  NemotronParsePatches page;
  ctx.RunPhase(kOcrPhasePreprocess, [&] {
    page = PreprocessRgb(frame.rgb, frame.width, frame.height);
  });
  OCR_LOGI("nemotron_parse image content=%dx%d padded=%dx%d rows=%d cols=%d", page.content_h,
           page.content_w, page.image_h, page.image_w, page.rows, page.cols);

  Ort::MemoryInfo mem = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
  const int64_t n_patches = static_cast<int64_t>(page.rows) * page.cols;
  std::vector<float> patch_emb;
  ctx.RunPhase(kOcrPhasePatch, [&] {
    const std::array<int64_t, 2> shape{n_patches, kPatchIn};
    Ort::Value in = Ort::Value::CreateTensor<float>(
        mem, page.patches.data(), page.patches.size(), shape.data(), shape.size());
    const char* in_names[] = {"patches"};
    const char* out_names[] = {"patch_tokens"};
    auto outputs = patch_session_->Run(Ort::RunOptions{nullptr}, in_names, &in, 1, out_names, 1);
    const auto dims = outputs[0].GetTensorTypeAndShapeInfo().GetShape();
    if (dims.size() != 2 || dims[0] != n_patches || dims[1] != kVisionWidth) {
      throw std::runtime_error("NemotronParseBackend: unexpected patch_embed shape");
    }
    const float* data = outputs[0].GetTensorData<float>();
    patch_emb.assign(data, data + static_cast<size_t>(n_patches * kVisionWidth));
  });

  std::vector<float> positioned = AddNavitPositions(
      patch_emb, pos_embed_, page.image_h, page.image_w, page.content_h, page.content_w);
  patch_emb.clear();
  page.patches.clear();

  std::vector<float> vision;
  std::vector<float> visual_mask;
  ctx.RunPhase(kOcrPhaseVision, [&] {
    const std::array<int64_t, 4> shape{1, page.rows, page.cols, kVisionWidth};
    Ort::Value in = Ort::Value::CreateTensor<float>(
        mem, positioned.data(), positioned.size(), shape.data(), shape.size());
    const char* in_names[] = {"patch_tokens"};
    const char* out_names[] = {"vision", "visual_mask"};
    auto outputs =
        vision_session_->Run(Ort::RunOptions{nullptr}, in_names, &in, 1, out_names, 2);
    const auto vdims = outputs[0].GetTensorTypeAndShapeInfo().GetShape();
    if (vdims.size() != 3 || vdims[0] != 1 || vdims[2] != kDecoderWidth) {
      throw std::runtime_error("NemotronParseBackend: unexpected vision shape");
    }
    const int64_t vis_len = vdims[1];
    const float* vdata = outputs[0].GetTensorData<float>();
    vision.assign(vdata, vdata + static_cast<size_t>(vis_len * kDecoderWidth));
    const auto mdims = outputs[1].GetTensorTypeAndShapeInfo().GetShape();
    const size_t mcount = outputs[1].GetTensorTypeAndShapeInfo().GetElementCount();
    visual_mask.resize(mcount, 1.f);
    const auto mtype = outputs[1].GetTensorTypeAndShapeInfo().GetElementType();
    if (mtype == ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT) {
      const float* md = outputs[1].GetTensorData<float>();
      visual_mask.assign(md, md + mcount);
    } else if (mtype == ONNX_TENSOR_ELEMENT_DATA_TYPE_BOOL) {
      const auto* md = outputs[1].GetTensorData<bool>();
      for (size_t i = 0; i < mcount; ++i) visual_mask[i] = md[i] ? 1.f : 0.f;
    }
    if (visual_mask.size() != static_cast<size_t>(vis_len)) {
      visual_mask.assign(static_cast<size_t>(vis_len), 1.f);
    }
    OCR_LOGI("nemotron_parse vision_len=%lld", static_cast<long long>(vis_len));
  });
  positioned.clear();

  const std::vector<int32_t> prompt = tokenizer_.Encode(kPrompt);
  if (prompt.empty()) {
    throw std::runtime_error("NemotronParseBackend: empty prompt encode");
  }
  OCR_LOGI("nemotron_parse prompt_len=%zu", prompt.size());

  std::vector<float> text_embeds;
  ctx.RunPhase(kOcrPhaseEmbed, [&] {
    std::vector<int64_t> ids64(prompt.begin(), prompt.end());
    const std::array<int64_t, 2> shape{1, static_cast<int64_t>(ids64.size())};
    Ort::Value ids = Ort::Value::CreateTensor<int64_t>(
        mem, ids64.data(), ids64.size(), shape.data(), shape.size());
    const char* in_names[] = {"input_ids"};
    const char* out_names[] = {"inputs_embeds"};
    auto outputs = embed_session_->Run(Ort::RunOptions{nullptr}, in_names, &ids, 1, out_names, 1);
    const auto dims = outputs[0].GetTensorTypeAndShapeInfo().GetShape();
    if (dims.size() != 3 || dims[0] != 1 || dims[2] != kDecoderWidth) {
      throw std::runtime_error("NemotronParseBackend: unexpected embed shape");
    }
    const float* data = outputs[0].GetTensorData<float>();
    text_embeds.assign(data, data + static_cast<size_t>(dims[1] * kDecoderWidth));
  });

  const int64_t vis_len = static_cast<int64_t>(vision.size() / kDecoderWidth);
  const int64_t prompt_len = static_cast<int64_t>(prompt.size());
  const int64_t seq0 = vis_len + prompt_len;
  std::vector<float> prefill;
  prefill.reserve(static_cast<size_t>(seq0 * kDecoderWidth));
  prefill.insert(prefill.end(), vision.begin(), vision.end());
  prefill.insert(prefill.end(), text_embeds.begin(), text_embeds.end());
  vision.clear();
  text_embeds.clear();

  std::vector<float> attn;
  attn.reserve(static_cast<size_t>(seq0));
  attn.insert(attn.end(), visual_mask.begin(), visual_mask.end());
  attn.insert(attn.end(), static_cast<size_t>(prompt_len), 1.f);

  const int max_new = ResolveMaxNewTokens(options_.max_new_tokens, static_cast<int>(seq0));
  float past_dummy = 0.f;
  std::vector<Ort::Value> past;
  const std::array<int64_t, 4> empty_shape{1, kKvHeads, 0, kHeadDim};
  for (int i = 0; i < kNumLayers * 2; ++i) {
    past.push_back(Ort::Value::CreateTensor<float>(mem, &past_dummy, 0, empty_shape.data(),
                                                   empty_shape.size()));
  }

  auto run_decoder = [&](std::vector<float>& embed_buf, int64_t seq,
                         std::vector<float>& mask) -> std::vector<Ort::Value> {
    const std::array<int64_t, 3> embed_shape{1, seq, kDecoderWidth};
    const std::array<int64_t, 2> mask_shape{1, static_cast<int64_t>(mask.size())};
    std::vector<Ort::Value> inputs;
    inputs.reserve(decoder_input_names_.size());
    inputs.push_back(Ort::Value::CreateTensor<float>(
        mem, embed_buf.data(), embed_buf.size(), embed_shape.data(), embed_shape.size()));
    inputs.push_back(Ort::Value::CreateTensor<float>(
        mem, mask.data(), mask.size(), mask_shape.data(), mask_shape.size()));
    for (auto& value : past) inputs.push_back(std::move(value));
    past.clear();
    std::vector<const char*> in_ptrs;
    std::vector<const char*> out_ptrs;
    for (const auto& name : decoder_input_names_) in_ptrs.push_back(name.c_str());
    for (const auto& name : decoder_output_names_) out_ptrs.push_back(name.c_str());
    return decoder_session_->Run(Ort::RunOptions{nullptr}, in_ptrs.data(), inputs.data(),
                                 inputs.size(), out_ptrs.data(), out_ptrs.size());
  };

  auto take_logits = [&](std::vector<Ort::Value>& outputs, int64_t seq) -> const float* {
    const auto dims = outputs[0].GetTensorTypeAndShapeInfo().GetShape();
    if (dims.size() != 3 || dims[0] != 1 || dims[1] != seq || dims[2] != kVocab) {
      throw std::runtime_error("NemotronParseBackend: unexpected logits shape");
    }
    return outputs[0].GetTensorData<float>();
  };

  auto keep_past = [&](std::vector<Ort::Value>& outputs) {
    past.clear();
    for (size_t i = 1; i < outputs.size(); ++i) past.push_back(std::move(outputs[i]));
    outputs.clear();
  };

  int32_t next = 0;
  long long prefill_ms = 0;
  ctx.RunPhase(kOcrPhasePrefill, [&] {
    const auto t_prefill = std::chrono::steady_clock::now();
    auto prefill_out = run_decoder(prefill, seq0, attn);
    const float* prefill_logits = take_logits(prefill_out, seq0);
    next = ArgmaxWithPenalty(prefill_logits + static_cast<size_t>(seq0 - 1) * kVocab, kVocab,
                             prompt, kRepetitionPenalty);
    keep_past(prefill_out);
    prefill.clear();
    prefill_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                     std::chrono::steady_clock::now() - t_prefill)
                     .count();
  });

  std::vector<int32_t> generated;
  std::vector<int32_t> all_ids = prompt;
  std::string stop_reason = "max_new_tokens";
  auto snap_decode = [&]() {
    const int n = static_cast<int>(generated.size());
    const int shown = n > 0 ? n : 1;
    ctx.Report(kOcrPhaseDecode, shown, shown);
  };
  ctx.ThrowIfCancelled();
  ctx.Report(kOcrPhaseDecode, 0, max_new);
  const auto t_decode = std::chrono::steady_clock::now();
  for (int step = 1; step <= max_new; ++step) {
    ctx.ThrowIfCancelled();
    const bool log_step = (step % 32 == 0);
    if (next == kEosId) {
      stop_reason = "eos";
      OCR_LOGI("nemotron_parse decode step=%d token=%d", step, next);
      snap_decode();
      break;
    }
    generated.push_back(next);
    all_ids.push_back(next);
    ctx.Report(kOcrPhaseDecode, static_cast<int>(generated.size()), max_new);
    if (static_cast<int>(generated.size()) == max_new) {
      stop_reason = "max_new_tokens";
      OCR_LOGI("nemotron_parse decode step=%d token=%d", step, next);
      snap_decode();
      break;
    }
    if (log_step) OCR_LOGI("nemotron_parse decode step=%d token=%d", step, next);

    std::vector<int64_t> one_id{next};
    const std::array<int64_t, 2> one_shape{1, 1};
    Ort::Value one = Ort::Value::CreateTensor<int64_t>(
        mem, one_id.data(), one_id.size(), one_shape.data(), one_shape.size());
    const char* in_names[] = {"input_ids"};
    const char* out_names[] = {"inputs_embeds"};
    auto embed_out = embed_session_->Run(Ort::RunOptions{nullptr}, in_names, &one, 1, out_names, 1);
    const float* row = embed_out[0].GetTensorData<float>();
    std::vector<float> one_embed(row, row + kDecoderWidth);
    embed_out.clear();
    attn.push_back(1.f);
    auto step_out = run_decoder(one_embed, 1, attn);
    const float* logits = take_logits(step_out, 1);
    next = ArgmaxWithPenalty(logits, kVocab, all_ids, kRepetitionPenalty);
    keep_past(step_out);
  }
  const auto decode_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                             std::chrono::steady_clock::now() - t_decode)
                             .count();

  NemotronParseMarkup parsed;
  ctx.RunPhase(kOcrPhaseParse, [&] {
    const std::string decoded = tokenizer_.Decode(generated);
    parsed = ParseNemotronMarkup(decoded, frame.width, frame.height, frame.frame_index);
  });
  OcrResult result;
  result.raw_utf8 = std::move(parsed.raw_utf8);
  result.markdown_utf8 = std::move(parsed.markdown_utf8);
  result.text_utf8 = std::move(parsed.text_utf8);
  result.spans = std::move(parsed.spans);
  result.stop_reason = stop_reason;
  result.complete = (stop_reason == "eos");
  OCR_LOGI(
      "nemotron_parse decode_perf prefill_ms=%lld decode_ms=%lld generated=%zu "
      "stop=%s complete=%d text=%zu spans=%zu",
      static_cast<long long>(prefill_ms), static_cast<long long>(decode_ms), generated.size(),
      stop_reason.c_str(), result.complete ? 1 : 0, result.text_utf8.size(),
      result.spans.size());
  return result;
}

}  // namespace nemotron_parse
}  // namespace ocr
}  // namespace sherpa_onnx
