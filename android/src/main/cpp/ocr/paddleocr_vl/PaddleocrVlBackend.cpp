#include "PaddleocrVlBackend.h"

#include "PaddleocrVlImageOps.h"
#include "PaddleocrVlLog.h"
#include "PaddleocrVlMarkup.h"
#include "PaddleocrVlRope.h"
#include "PaddleocrVlPrompt.h"
#include "PaddleocrVlTaskProfile.h"
#include "../OcrInstruction.h"
#include "../OcrOrtEnv.h"
#include "../OcrOrtHelpers.h"

#include <onnxruntime_cxx_api.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <variant>
#include <unordered_set>
#include <utility>
#include <vector>

namespace sherpa_onnx {
namespace ocr {
namespace paddleocr_vl {
namespace {

constexpr int kBosId = 1;
constexpr int kEosId = 2;
constexpr int kImageTokenId = 100295;
constexpr int kDefaultMaxNewTokens = 8192;
constexpr int kMaxPositions = 16384;
constexpr int kNumLayers = 18;
constexpr int kKvHeads = 2;
constexpr int kHeadDim = 128;
constexpr int kVocab = 103424;
constexpr int kDecoderWidth = 1024;
constexpr int kSpatialMerge = 2;
constexpr const char* kWho = "PaddleocrVlBackend";

const PaddleocrVlTaskProfile& ResolveProfile(const OcrRecognizeContext& ctx) {
  const auto* inst =
      std::get_if<PaddleocrVlInstruction>(&ctx.request.instruction);
  return ProfileFor(inst ? inst->task : PaddleocrVlTask::kOcr);
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
    throw std::runtime_error(std::string("PaddleocrVlBackend: ") + what + " missing " +
                             name);
  }
}

int ResolveMaxNewTokens(int requested, int prefix_len) {
  int cap = requested <= 0 ? kDefaultMaxNewTokens : requested;
  if (cap > kDefaultMaxNewTokens) cap = kDefaultMaxNewTokens;
  if (prefix_len + cap > kMaxPositions) {
    const int lowered = std::max(0, kMaxPositions - prefix_len);
    OCR_LOGI("paddleocr_vl clamp max_new_tokens %d -> %d prefix=%d max_pos=%d", cap, lowered,
             prefix_len, kMaxPositions);
    cap = lowered;
  }
  return cap;
}

int ResolveMaxPixels(int requested) {
  return requested <= 0 ? kOfficialMaxPixels : requested;
}

long long RssKb() {
  std::ifstream in("/proc/self/status");
  if (!in) return -1;
  std::string line;
  while (std::getline(in, line)) {
    if (line.rfind("VmRSS:", 0) != 0) continue;
    long long kb = -1;
    const auto pos = line.find_first_of("0123456789");
    if (pos != std::string::npos) kb = std::strtoll(line.c_str() + pos, nullptr, 10);
    return kb;
  }
  return -1;
}

void LogPhaseRss(const char* phase) {
  OCR_LOGI("paddleocr_vl rss phase=%s rss_kb=%lld", phase,
           static_cast<long long>(RssKb()));
}

}  // namespace

PaddleocrVlBackend::PaddleocrVlBackend() = default;
PaddleocrVlBackend::~PaddleocrVlBackend() { Release(); }

void PaddleocrVlBackend::Release() {
  loaded_ = false;
  decoder_input_names_.clear();
  decoder_output_names_.clear();
  vision_session_.reset();
  embed_session_.reset();
  decoder_session_.reset();
  session_options_.reset();
  tokenizer_ = PaddleocrVlTokenizer{};
  manifest_ = PaddleocrVlManifest{};
}

void PaddleocrVlBackend::Load(const std::string& model_dir, const OcrLoadOptions& options) {
  Release();
  options_ = options;

  const std::string vision_path =
      OcrResolvePath(options.path_vision_encoder, model_dir, "vision_encoder.onnx");
  const std::string vision_data = OcrResolvePath(options.path_vision_encoder_data, model_dir,
                                                 "vision_encoder.onnx_data");
  const std::string embed_path =
      OcrResolvePath(options.path_embedding, model_dir, "embedding.onnx");
  const std::string embed_data =
      OcrResolvePath(options.path_embedding_data, model_dir, "embedding.onnx_data");
  const std::string decoder_path =
      OcrResolvePath(options.path_decoder, model_dir, "decoder.onnx");
  const std::string decoder_data =
      OcrResolvePath(options.path_decoder_data, model_dir, "decoder.onnx_data");
  const std::string tokenizer_path =
      OcrResolvePath(options.path_tokenizer, model_dir, "tokenizer.json");
  const std::string manifest_path =
      OcrResolvePath(options.path_manifest, model_dir, "ocr_manifest.json");

  for (const auto& path : {vision_path, embed_path, decoder_path, tokenizer_path}) {
    OcrRequireRegularFile(path, kWho);
  }
  for (const auto& path : {vision_data, embed_data, decoder_data}) {
    std::error_code ec;
    if (!path.empty() && std::filesystem::is_regular_file(path, ec) && !ec) {
      OcrRequireRegularFile(path, kWho);
    }
  }
  {
    std::error_code ec;
    if (std::filesystem::is_regular_file(manifest_path, ec) && !ec) {
      manifest_ = ParsePaddleocrVlManifestFile(manifest_path);
    }
  }
  tokenizer_ = PaddleocrVlTokenizer::Load(tokenizer_path);
  if (tokenizer_.TokenId("<s>") != kBosId || tokenizer_.TokenId("</s>") != kEosId) {
    throw std::runtime_error("PaddleocrVlBackend: BOS/EOS ids do not match");
  }
  if (tokenizer_.TokenId("<|IMAGE_PLACEHOLDER|>") != kImageTokenId) {
    throw std::runtime_error("PaddleocrVlBackend: image token id is not 100295");
  }

  Ort::Env& env = SharedOrtEnv();
  session_options_ = std::make_unique<Ort::SessionOptions>(
      OcrMakeVlmSessionOptions(options_.num_threads, options_.provider));

  const auto open_session = [&](const std::string& path, const char* label) {
    return OcrCreateOrtSession(env, *session_options_, path, label, options_.provider);
  };
  vision_session_ = open_session(vision_path, "vision_encoder.onnx");
  embed_session_ = open_session(embed_path, "embedding.onnx");
  decoder_session_ = open_session(decoder_path, "decoder.onnx");

  RequireName(IoNames(*vision_session_, true), "pixel_values", "vision");
  RequireName(IoNames(*vision_session_, true), "image_grid_thw", "vision");
  RequireName(IoNames(*vision_session_, false), "image_embeds", "vision");
  RequireName(IoNames(*embed_session_, true), "input_ids", "embed");
  RequireName(IoNames(*embed_session_, false), "embeddings", "embed");

  decoder_input_names_.push_back("inputs_embeds");
  decoder_input_names_.push_back("attention_mask");
  decoder_input_names_.push_back("position_ids");
  decoder_output_names_.push_back("logits");
  for (int layer = 0; layer < kNumLayers; ++layer) {
    decoder_input_names_.push_back("past_key_values." + std::to_string(layer) + ".key");
    decoder_input_names_.push_back("past_key_values." + std::to_string(layer) + ".value");
    decoder_output_names_.push_back("present." + std::to_string(layer) + ".key");
    decoder_output_names_.push_back("present." + std::to_string(layer) + ".value");
  }
  const auto dec_in = IoNames(*decoder_session_, true);
  const auto dec_out = IoNames(*decoder_session_, false);
  for (const auto& name : decoder_input_names_) RequireName(dec_in, name, "decoder");
  for (const auto& name : decoder_output_names_) RequireName(dec_out, name, "decoder");

  loaded_ = true;
  OCR_LOGI("paddleocr_vl loaded layers=%d kv=%d dim=%d vocab=%d max_pixels=%d", kNumLayers,
           kKvHeads, kHeadDim, kVocab, ResolveMaxPixels(options_.max_pixels));
  LogPhaseRss("load");
}

OcrResult PaddleocrVlBackend::Recognize(const OcrFrameView& frame,
                                        const OcrRecognizeContext& ctx) {
  if (!loaded_) throw std::runtime_error("PaddleocrVlBackend::Recognize called before Load");
  if (frame.rgb == nullptr || frame.width <= 0 || frame.height <= 0) {
    throw std::invalid_argument("PaddleocrVlBackend: invalid frame");
  }

  const auto& profile = ResolveProfile(ctx);
  PaddleocrVlPatches page;
  ctx.RunPhase(kOcrPhasePreprocess, [&] {
    PaddleocrVlPreprocessOptions prep;
    prep.init_max_pixels = options_.max_pixels;
    prep.task_max_pixels = profile.default_max_pixels;
    prep.upscale_small_2x = profile.upscale_small_2x;
    page = PreprocessRgb(frame.rgb, frame.width, frame.height, prep);
  });
  const int n_image = page.num_patches / (kSpatialMerge * kSpatialMerge);
  OCR_LOGI(
      "paddleocr_vl image src=%dx%d resized=%dx%d max_pixels=%d area=%d grid=%d,%d,%d "
      "patches=%d N=%d",
      page.src_w, page.src_h, page.resized_w, page.resized_h,
      page.effective_max_pixels, page.resized_w * page.resized_h, page.grid_t,
      page.grid_h, page.grid_w, page.num_patches, n_image);
  LogPhaseRss("preprocess");

  Ort::MemoryInfo mem = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);

  std::vector<float> image_embeds;
  ctx.RunPhase(kOcrPhaseVision, [&] {
    const std::array<int64_t, 5> pix_shape{1, page.num_patches, 3, 14, 14};
    const std::array<int64_t, 2> grid_shape{1, 3};
    std::array<int64_t, 3> grid{page.grid_t, page.grid_h, page.grid_w};
    Ort::Value pix = Ort::Value::CreateTensor<float>(
        mem, page.pixel_values.data(), page.pixel_values.size(), pix_shape.data(),
        pix_shape.size());
    Ort::Value thw =
        Ort::Value::CreateTensor<int64_t>(mem, grid.data(), grid.size(), grid_shape.data(),
                                          grid_shape.size());
    const char* in_names[] = {"pixel_values", "image_grid_thw"};
    const char* out_names[] = {"image_embeds"};
    Ort::Value inputs[] = {std::move(pix), std::move(thw)};
    auto outputs =
        vision_session_->Run(Ort::RunOptions{nullptr}, in_names, inputs, 2, out_names, 1);
    const auto dims = outputs[0].GetTensorTypeAndShapeInfo().GetShape();
    if (dims.size() != 2 || dims[0] != n_image || dims[1] != kDecoderWidth) {
      throw std::runtime_error("PaddleocrVlBackend: unexpected image_embeds shape");
    }
    const float* data = outputs[0].GetTensorData<float>();
    image_embeds.assign(data, data + static_cast<size_t>(dims[0] * dims[1]));
    outputs.clear();
  });
  page.pixel_values.clear();
  LogPhaseRss("vision");

  const std::string prompt_text = BuildPaddleocrVlPrompt(n_image, profile);
  const std::vector<int32_t> prompt = tokenizer_.Encode(prompt_text);
  if (prompt.empty()) {
    throw std::runtime_error("PaddleocrVlBackend: empty prompt encode");
  }
  std::vector<float> text_embeds;
  ctx.RunPhase(kOcrPhaseEmbed, [&] {
    std::vector<int64_t> ids64(prompt.begin(), prompt.end());
    const std::array<int64_t, 2> shape{1, static_cast<int64_t>(ids64.size())};
    Ort::Value ids = Ort::Value::CreateTensor<int64_t>(
        mem, ids64.data(), ids64.size(), shape.data(), shape.size());
    const char* in_names[] = {"input_ids"};
    const char* out_names[] = {"embeddings"};
    auto outputs = embed_session_->Run(Ort::RunOptions{nullptr}, in_names, &ids, 1, out_names, 1);
    const auto dims = outputs[0].GetTensorTypeAndShapeInfo().GetShape();
    if (dims.size() != 3 || dims[0] != 1 || dims[2] != kDecoderWidth) {
      throw std::runtime_error("PaddleocrVlBackend: unexpected embed shape");
    }
    const float* data = outputs[0].GetTensorData<float>();
    text_embeds.assign(data, data + static_cast<size_t>(dims[1] * kDecoderWidth));
    outputs.clear();
  });
  LogPhaseRss("embed");

  std::vector<int64_t> ids64(prompt.begin(), prompt.end());
  int n_slots = 0;
  for (int64_t id : ids64) {
    if (id == kImageTokenId) ++n_slots;
  }
  if (n_slots != n_image) {
    throw std::runtime_error("PaddleocrVlBackend: image tokens " + std::to_string(n_slots) +
                             " != features " + std::to_string(n_image));
  }
  std::vector<float> prefill = text_embeds;
  int slot = 0;
  for (size_t i = 0; i < ids64.size(); ++i) {
    if (ids64[i] != kImageTokenId) continue;
    const float* src = image_embeds.data() + static_cast<size_t>(slot) * kDecoderWidth;
    float* dst = prefill.data() + i * kDecoderWidth;
    std::copy(src, src + kDecoderWidth, dst);
    ++slot;
  }
  image_embeds.clear();
  text_embeds.clear();

  const int64_t seq0 = static_cast<int64_t>(ids64.size());
  std::vector<float> attn(static_cast<size_t>(seq0), 1.f);
  RopeIndex rope =
      ComputeRopeIndex(ids64, page.grid_t, page.grid_h, page.grid_w, kImageTokenId,
                       kSpatialMerge);

  const int max_new = ResolveMaxNewTokens(options_.max_new_tokens, static_cast<int>(seq0));
  std::vector<Ort::Value> past = OcrEmptyKvCache(mem, kNumLayers, kKvHeads, kHeadDim);

  auto run_decoder = [&](std::vector<float>& embed_buf, int64_t seq,
                         std::vector<float>& mask,
                         std::vector<int64_t>& pos) -> std::vector<Ort::Value> {
    const std::array<int64_t, 3> embed_shape{1, seq, kDecoderWidth};
    const std::array<int64_t, 2> mask_shape{1, static_cast<int64_t>(mask.size())};
    const std::array<int64_t, 3> pos_shape{3, 1, seq};
    std::vector<Ort::Value> inputs;
    inputs.reserve(decoder_input_names_.size());
    inputs.push_back(Ort::Value::CreateTensor<float>(
        mem, embed_buf.data(), embed_buf.size(), embed_shape.data(), embed_shape.size()));
    inputs.push_back(Ort::Value::CreateTensor<float>(
        mem, mask.data(), mask.size(), mask_shape.data(), mask_shape.size()));
    inputs.push_back(Ort::Value::CreateTensor<int64_t>(
        mem, pos.data(), pos.size(), pos_shape.data(), pos_shape.size()));
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
      throw std::runtime_error("PaddleocrVlBackend: unexpected logits shape");
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
    auto prefill_out = run_decoder(prefill, seq0, attn, rope.position_ids);
    const float* prefill_logits = take_logits(prefill_out, seq0);
    next = OcrArgmax(prefill_logits + static_cast<size_t>(seq0 - 1) * kVocab, kVocab);
    if (!prefill_out.empty()) {
      Ort::Value drop_logits = std::move(prefill_out[0]);
      (void)drop_logits;
    }
    keep_past(prefill_out);
    prefill.clear();
    prefill_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                     std::chrono::steady_clock::now() - t_prefill)
                     .count();
  });
  LogPhaseRss("prefill");

  std::vector<int32_t> generated;
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
      OCR_LOGI("paddleocr_vl decode step=%d token=%d", step, next);
      snap_decode();
      break;
    }
    generated.push_back(next);
    ctx.Report(kOcrPhaseDecode, static_cast<int>(generated.size()), max_new);
    if (static_cast<int>(generated.size()) == max_new) {
      stop_reason = "max_new_tokens";
      OCR_LOGI("paddleocr_vl decode step=%d token=%d", step, next);
      snap_decode();
      break;
    }
    if (log_step) {
      OCR_LOGI("paddleocr_vl decode step=%d token=%d", step, next);
      LogPhaseRss("decode");
    }

    std::vector<int64_t> one_id{next};
    const std::array<int64_t, 2> one_shape{1, 1};
    Ort::Value one = Ort::Value::CreateTensor<int64_t>(
        mem, one_id.data(), one_id.size(), one_shape.data(), one_shape.size());
    const char* in_names[] = {"input_ids"};
    const char* out_names[] = {"embeddings"};
    auto embed_out = embed_session_->Run(Ort::RunOptions{nullptr}, in_names, &one, 1, out_names, 1);
    const float* row = embed_out[0].GetTensorData<float>();
    std::vector<float> one_embed(row, row + kDecoderWidth);
    embed_out.clear();
    attn.push_back(1.f);
    std::vector<int64_t> pos =
        DecodePositionIds(static_cast<int>(seq0) + step - 1, static_cast<int>(rope.rope_delta),
                          1);
    auto step_out = run_decoder(one_embed, 1, attn, pos);
    const float* logits = take_logits(step_out, 1);
    next = OcrArgmax(logits, kVocab);
    keep_past(step_out);
  }
  const auto decode_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                             std::chrono::steady_clock::now() - t_decode)
                             .count();

  OcrResult result;
  ctx.RunPhase(kOcrPhaseParse, [&] {
    const std::string decoded = tokenizer_.Decode(generated);
    result.raw_utf8 = decoded;
    try {
      PaddleocrVlParseOptions parse_opts;
      parse_opts.task = profile.id;
      parse_opts.frame_width = frame.width;
      parse_opts.frame_height = frame.height;
      parse_opts.frame_index = frame.frame_index;
      PaddleocrVlMarkup parsed = ParsePaddleocrVlMarkup(decoded, parse_opts);
      result.raw_utf8 = std::move(parsed.raw_utf8);
      result.text_utf8 = std::move(parsed.text_utf8);
      result.spans = std::move(parsed.spans);
      result.elements = std::move(parsed.elements);
      SetOcrContent(result, profile.content_format, std::move(parsed.markdown_utf8));
    } catch (const OcrCodedError& e) {
      OCR_LOGW("paddleocr_vl parse failed code=%s raw=%zu — keeping raw",
               e.code().c_str(), result.raw_utf8.size());
    }
  });
  const OcrContentFormat format = profile.content_format;
  result.stop_reason = stop_reason;
  result.complete = (stop_reason == "eos");
  OCR_LOGI(
      "paddleocr_vl parse content_format=%s elements=%zu spans=%zu unknown=0 "
      "stop=%s",
      OcrContentFormatName(format), result.elements.size(), result.spans.size(),
      stop_reason.c_str());
  OCR_LOGI(
      "paddleocr_vl decode_perf prefill_ms=%lld decode_ms=%lld generated=%zu "
      "stop=%s complete=%d text=%zu raw=%zu content=%zu",
      static_cast<long long>(prefill_ms), static_cast<long long>(decode_ms), generated.size(),
      stop_reason.c_str(), result.complete ? 1 : 0, result.text_utf8.size(),
      result.raw_utf8.size(), result.content.value.size());
  return result;
}

}  // namespace paddleocr_vl
}  // namespace ocr
}  // namespace sherpa_onnx
