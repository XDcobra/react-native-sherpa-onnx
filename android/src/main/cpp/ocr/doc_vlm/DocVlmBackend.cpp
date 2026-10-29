#include "DocVlmBackend.h"

#include "DocVlmDocTags.h"
#include "DocVlmDocTagsPrefix.h"
#include "DocVlmImageOps.h"
#include "DocVlmPrompt.h"
#include "OcrOrtEnv.h"
#include "OcrOrtHelpers.h"
#include "ort/ApplyOrtProvider.h"

#include <onnxruntime_cxx_api.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <unordered_set>
#include <utility>
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
#define OCR_LOGI(...)                          \
  do {                                         \
    std::fprintf(stderr, "[SherpaOnnx:ocr] "); \
    std::fprintf(stderr, __VA_ARGS__);         \
    std::fprintf(stderr, "\n");                \
  } while (0)
#define OCR_LOGW(...) OCR_LOGI(__VA_ARGS__)
#endif

namespace sherpa_onnx {
namespace ocr {
namespace doc_vlm {
namespace {

constexpr int kBosId = 100264;
constexpr int kEosId = 100257;
constexpr int kImageTokenId = 100270;
constexpr int kDoctagEndId = 100328;
constexpr int kDefaultMaxNewTokens = 8192;
constexpr int kMaxPositions = 8192;

std::string JoinPath(const std::string& dir, const std::string& file) {
  fs::path path(dir);
  path /= file;
  return path.string();
}

void RequireNonEmptyFile(const std::string& path) {
  std::error_code ec;
  if (!fs::is_regular_file(path, ec) || ec) {
    throw std::runtime_error("DocVlmBackend: missing " + path);
  }
  if (fs::file_size(path, ec) == 0 || ec) {
    throw std::runtime_error("DocVlmBackend: empty " + path);
  }
}

std::unordered_set<std::string> IoNames(Ort::Session& session, bool input) {
  Ort::AllocatorWithDefaultOptions alloc;
  const size_t count = input ? session.GetInputCount() : session.GetOutputCount();
  std::unordered_set<std::string> names;
  names.reserve(count);
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
    throw std::runtime_error(std::string("DocVlmBackend: ") + what + " missing " + name);
  }
}

void LstripAsciiWs(std::string& text) {
  size_t i = 0;
  while (i < text.size() &&
         (text[i] == ' ' || text[i] == '\t' || text[i] == '\r' || text[i] == '\n')) {
    ++i;
  }
  if (i > 0) text.erase(0, i);
}

int32_t Argmax(const float* row, int n) {
  if (n <= 0 || row == nullptr) {
    throw std::runtime_error("DocVlmBackend: empty logits row");
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

int ResolveMaxNewTokens(int requested, int prompt_len) {
  int cap = requested <= 0 ? kDefaultMaxNewTokens : requested;
  if (cap > kDefaultMaxNewTokens) cap = kDefaultMaxNewTokens;
  if (prompt_len + cap > kMaxPositions) {
    const int lowered = std::max(0, kMaxPositions - prompt_len);
    OCR_LOGI("doc_vlm clamp max_new_tokens %d -> %d prompt=%d max_pos=%d", cap, lowered,
             prompt_len, kMaxPositions);
    cap = lowered;
  }
  return cap;
}

}  // namespace

DocVlmBackend::DocVlmBackend() = default;

DocVlmBackend::~DocVlmBackend() { Release(); }

void DocVlmBackend::Release() {
  loaded_ = false;
  doctag_end_id_ = 0;
  prompt_only_ids_.clear();
  decoder_input_names_.clear();
  decoder_output_names_.clear();
  vision_session_.reset();
  embed_session_.reset();
  decoder_session_.reset();
  session_options_.reset();
  tokenizer_ = DocVlmTokenizer{};
  manifest_ = DocVlmManifest{};
  kv_float16_ = false;
}

void DocVlmBackend::Load(const std::string& model_dir, const OcrLoadOptions& options) {
  Release();
  options_ = options;

  const std::string vision_path = OcrResolvePath(
      options.path_vision_encoder, model_dir, "vision_encoder.onnx");
  const std::string vision_data_path = OcrResolvePath(
      options.path_vision_encoder_data, model_dir, "vision_encoder.onnx_data");
  const std::string embed_path =
      OcrResolvePath(options.path_embed_tokens, model_dir, "embed_tokens.onnx");
  const std::string embed_data_path = OcrResolvePath(
      options.path_embed_tokens_data, model_dir, "embed_tokens.onnx_data");
  const std::string decoder_path = OcrResolvePath(
      options.path_decoder, model_dir, "decoder_model_merged.onnx");
  const std::string decoder_data_path = OcrResolvePath(
      options.path_decoder_data, model_dir, "decoder_model_merged.onnx_data");
  const std::string tokenizer_path =
      OcrResolvePath(options.path_tokenizer, model_dir, "tokenizer.json");
  const std::string manifest_path =
      OcrResolvePath(options.path_manifest, model_dir, "ocr_manifest.json");

  for (const auto& path :
       {vision_path, vision_data_path, embed_path, embed_data_path, decoder_path,
        decoder_data_path, tokenizer_path, manifest_path}) {
    RequireNonEmptyFile(path);
  }

  manifest_ = ParseDocVlmManifestFile(manifest_path);
  if (manifest_.num_key_value_heads != 3 || manifest_.head_dim != 64 ||
      manifest_.max_position_embeddings != kMaxPositions) {
    throw std::runtime_error(
        "DocVlmBackend: pack KV heads, head dim, or max positions do not match the spike");
  }
  if (manifest_.bos_token_id != kBosId || manifest_.eos_token_id != kEosId ||
      manifest_.image_token_id != kImageTokenId) {
    throw std::runtime_error("DocVlmBackend: special token ids do not match granite-docling");
  }
  kv_float16_ = manifest_.onnx_dtype == "fp16" || manifest_.onnx_dtype == "q4f16";
  OCR_LOGI("doc_vlm onnx_dtype=%s kv=%s", manifest_.onnx_dtype.c_str(),
           kv_float16_ ? "float16" : "float32");

  tokenizer_ = DocVlmTokenizer::Load(tokenizer_path);
  if (tokenizer_.TokenId("<|start_of_role|>") != manifest_.bos_token_id ||
      tokenizer_.TokenId("<|end_of_text|>") != manifest_.eos_token_id ||
      tokenizer_.TokenId("<image>") != manifest_.image_token_id) {
    throw std::runtime_error("DocVlmBackend: tokenizer specials do not match the manifest");
  }
  doctag_end_id_ = tokenizer_.TokenId("</doctag>");
  if (doctag_end_id_ != kDoctagEndId) {
    throw std::runtime_error("DocVlmBackend: </doctag> id is not 100328");
  }
  prompt_only_ids_.clear();
  prompt_only_ids_.insert(manifest_.image_token_id);
  const char* kPromptOnly[] = {
      "<image>",
      "<fake_token_around_image>",
      "<global-img>",
      "<|start_of_role|>",
      "<|end_of_role|>",
  };
  for (const char* token : kPromptOnly) {
    try {
      prompt_only_ids_.insert(tokenizer_.TokenId(token));
    } catch (const std::exception&) {
    }
  }
  for (int row = 1; row <= 4; ++row) {
    for (int col = 1; col <= 4; ++col) {
      try {
        prompt_only_ids_.insert(tokenizer_.TokenId("<row_" + std::to_string(row) +
                                                   "_col_" + std::to_string(col) + ">"));
      } catch (const std::exception&) {
      }
    }
  }

  Ort::Env& env = SharedOrtEnv();
  session_options_ = std::make_unique<Ort::SessionOptions>();
  session_options_->SetIntraOpNumThreads(std::max(1, options_.num_threads));
  session_options_->SetInterOpNumThreads(1);
  session_options_->SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_EXTENDED);
  ApplyOrtProvider(*session_options_, options_.provider);

  const auto open_session = [&](const std::string& path, const char* label) {
    return OcrCreateOrtSession(env, *session_options_, path, label, options_.provider);
  };
  vision_session_ = open_session(vision_path, "vision_encoder.onnx");
  embed_session_ = open_session(embed_path, "embed_tokens.onnx");
  decoder_session_ = open_session(decoder_path, "decoder_model_merged.onnx");

  const auto vision_in = IoNames(*vision_session_, true);
  const auto vision_out = IoNames(*vision_session_, false);
  RequireName(vision_in, "pixel_values", "vision");
  RequireName(vision_in, "pixel_attention_mask", "vision");
  RequireName(vision_out, "image_features", "vision");

  const auto embed_in = IoNames(*embed_session_, true);
  const auto embed_out = IoNames(*embed_session_, false);
  RequireName(embed_in, "input_ids", "embed");
  RequireName(embed_out, "inputs_embeds", "embed");

  decoder_input_names_.push_back("inputs_embeds");
  decoder_input_names_.push_back("attention_mask");
  decoder_output_names_.push_back("logits");
  for (int layer = 0; layer < manifest_.num_hidden_layers; ++layer) {
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
  OCR_LOGI("doc_vlm loaded layers=%d hidden=%d vocab=%d", manifest_.num_hidden_layers,
           manifest_.hidden_size, manifest_.vocab_size);
}

OcrResult DocVlmBackend::Recognize(const OcrFrameView& frame,
                                   const OcrRecognizeContext& ctx) {
  if (!loaded_) {
    throw std::runtime_error("DocVlmBackend::Recognize called before Load");
  }
  if (frame.rgb == nullptr || frame.width <= 0 || frame.height <= 0) {
    throw std::invalid_argument("DocVlmBackend: invalid frame");
  }
  if (!embed_session_ || !decoder_session_ || !vision_session_) {
    throw std::runtime_error("DocVlmBackend: sessions not loaded");
  }

  DocVlmTiles tiles;
  ctx.RunPhase(kOcrPhasePreprocess, [&] {
    tiles = PreprocessRgb(frame.rgb, frame.width, frame.height, manifest_.size_longest_edge,
                          manifest_.image_size, manifest_.rescale_factor, manifest_.mean.data(),
                          manifest_.std.data());
  });
  OCR_LOGI("doc_vlm tiles rows=%d cols=%d num_images=%d canvas=%dx%d", tiles.rows, tiles.cols,
           tiles.num_images, tiles.canvas_width, tiles.canvas_height);
  const int num_images = tiles.num_images;
  const int rows = tiles.rows;
  const int cols = tiles.cols;

  Ort::MemoryInfo mem = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
  std::vector<float> features;
  ctx.RunPhase(kOcrPhaseVision, [&] {
    const std::array<int64_t, 5> pixel_shape{
        1, num_images, 3, manifest_.image_size, manifest_.image_size};
    const std::array<int64_t, 4> mask_shape{
        1, num_images, manifest_.image_size, manifest_.image_size};
    Ort::Value pixels = Ort::Value::CreateTensor<float>(
        mem, tiles.nchw.data(), tiles.nchw.size(), pixel_shape.data(), pixel_shape.size());
    Ort::Value mask = Ort::Value::CreateTensor(
        mem, static_cast<void*>(tiles.mask.data()), tiles.mask.size(), mask_shape.data(),
        mask_shape.size(), ONNX_TENSOR_ELEMENT_DATA_TYPE_BOOL);
    const char* in_names[] = {"pixel_values", "pixel_attention_mask"};
    const char* out_names[] = {"image_features"};
    Ort::Value inputs[] = {std::move(pixels), std::move(mask)};
    auto outputs = vision_session_->Run(Ort::RunOptions{nullptr}, in_names, inputs, 2, out_names, 1);
    const auto info = outputs[0].GetTensorTypeAndShapeInfo();
    const auto dims = info.GetShape();
    if (dims.size() != 3 || dims[0] != num_images || dims[1] != manifest_.image_seq_len ||
        dims[2] != manifest_.hidden_size) {
      throw std::runtime_error("DocVlmBackend: unexpected image_features shape");
    }
    OCR_LOGI("doc_vlm image_features [%lld,%lld,%lld]", static_cast<long long>(dims[0]),
             static_cast<long long>(dims[1]), static_cast<long long>(dims[2]));
    const float* data = outputs[0].GetTensorData<float>();
    const size_t count = static_cast<size_t>(dims[0] * dims[1] * dims[2]);
    features.assign(data, data + count);
  });
  tiles = DocVlmTiles{};

  const std::vector<int32_t> prompt = BuildPromptIds(tokenizer_, rows, cols);
  int image_tokens = 0;
  for (int32_t id : prompt) {
    if (id == manifest_.image_token_id) ++image_tokens;
  }
  if (image_tokens != num_images * manifest_.image_seq_len) {
    throw std::runtime_error("DocVlmBackend: image token count does not match tiles");
  }
  OCR_LOGI("doc_vlm prompt_len=%zu image_tokens=%d", prompt.size(), image_tokens);

  const int64_t seq0 = static_cast<int64_t>(prompt.size());
  std::vector<float> embeds;
  ctx.RunPhase(kOcrPhaseEmbed, [&] {
    std::vector<int64_t> ids64(prompt.begin(), prompt.end());
    const std::array<int64_t, 2> id_shape{1, seq0};
    Ort::Value ids = Ort::Value::CreateTensor<int64_t>(
        mem, ids64.data(), ids64.size(), id_shape.data(), id_shape.size());
    const char* in_names[] = {"input_ids"};
    const char* out_names[] = {"inputs_embeds"};
    auto outputs = embed_session_->Run(Ort::RunOptions{nullptr}, in_names, &ids, 1, out_names, 1);
    const auto dims = outputs[0].GetTensorTypeAndShapeInfo().GetShape();
    if (dims.size() != 3 || dims[0] != 1 || dims[1] != seq0 || dims[2] != manifest_.hidden_size) {
      throw std::runtime_error("DocVlmBackend: unexpected inputs_embeds shape");
    }
    const float* data = outputs[0].GetTensorData<float>();
    embeds.assign(data, data + static_cast<size_t>(seq0 * manifest_.hidden_size));

    size_t feat_cursor = 0;
    int scattered = 0;
    for (size_t i = 0; i < prompt.size(); ++i) {
      if (prompt[i] != manifest_.image_token_id) continue;
      if (feat_cursor + static_cast<size_t>(manifest_.hidden_size) > features.size()) {
        throw std::runtime_error("DocVlmBackend: image feature cursor overflow");
      }
      std::copy_n(features.data() + feat_cursor, static_cast<size_t>(manifest_.hidden_size),
                  embeds.data() + i * static_cast<size_t>(manifest_.hidden_size));
      feat_cursor += static_cast<size_t>(manifest_.hidden_size);
      ++scattered;
    }
    if (scattered != image_tokens || feat_cursor != features.size()) {
      throw std::runtime_error("DocVlmBackend: image feature scatter did not consume features");
    }
    features.clear();
    features.shrink_to_fit();
  });

  const int max_new = ResolveMaxNewTokens(options_.max_new_tokens, static_cast<int>(prompt.size()));
  const int layers = manifest_.num_hidden_layers;
  const int kv_heads = manifest_.num_key_value_heads;
  const int head_dim = manifest_.head_dim;
  const int vocab = manifest_.vocab_size;

  float past_dummy_f32 = 0.f;
  uint16_t past_dummy_f16 = 0;
  std::vector<Ort::Value> past;
  const int past_slots = layers * 2;
  past.reserve(static_cast<size_t>(past_slots));
  const std::array<int64_t, 4> empty_shape{1, kv_heads, 0, head_dim};
  while (static_cast<int>(past.size()) < past_slots) {
    if (kv_float16_) {
      past.push_back(Ort::Value::CreateTensor(
          mem, static_cast<void*>(&past_dummy_f16), 0, empty_shape.data(),
          empty_shape.size(), ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT16));
    } else {
      past.push_back(Ort::Value::CreateTensor<float>(
          mem, &past_dummy_f32, 0, empty_shape.data(), empty_shape.size()));
    }
  }

  auto run_decoder = [&](std::vector<float>& embed_buf, int64_t seq,
                         std::vector<int64_t>& mask) -> std::vector<Ort::Value> {
    const std::array<int64_t, 3> embed_shape{1, seq, manifest_.hidden_size};
    const std::array<int64_t, 2> mask_shape{1, static_cast<int64_t>(mask.size())};
    std::vector<Ort::Value> inputs;
    inputs.reserve(decoder_input_names_.size());
    inputs.push_back(Ort::Value::CreateTensor<float>(
        mem, embed_buf.data(), embed_buf.size(), embed_shape.data(), embed_shape.size()));
    inputs.push_back(Ort::Value::CreateTensor<int64_t>(
        mem, mask.data(), mask.size(), mask_shape.data(), mask_shape.size()));
    for (auto& value : past) inputs.push_back(std::move(value));
    past.clear();
    if (inputs.size() != decoder_input_names_.size()) {
      throw std::runtime_error("DocVlmBackend: decoder input count mismatch");
    }
    std::vector<const char*> in_ptrs;
    std::vector<const char*> out_ptrs;
    in_ptrs.reserve(decoder_input_names_.size());
    out_ptrs.reserve(decoder_output_names_.size());
    for (const auto& name : decoder_input_names_) in_ptrs.push_back(name.c_str());
    for (const auto& name : decoder_output_names_) out_ptrs.push_back(name.c_str());
    return decoder_session_->Run(Ort::RunOptions{nullptr}, in_ptrs.data(), inputs.data(),
                                 inputs.size(), out_ptrs.data(), out_ptrs.size());
  };

  auto take_next = [&](std::vector<Ort::Value>& outputs, int64_t seq) -> int32_t {
    const auto dims = outputs[0].GetTensorTypeAndShapeInfo().GetShape();
    if (dims.size() != 3 || dims[0] != 1 || dims[1] != seq || dims[2] != vocab) {
      throw std::runtime_error("DocVlmBackend: unexpected logits shape");
    }
    const float* logits = outputs[0].GetTensorData<float>();
    const int32_t next = Argmax(logits + static_cast<size_t>(seq - 1) * static_cast<size_t>(vocab),
                                vocab);
    if (outputs.size() != decoder_output_names_.size()) {
      throw std::runtime_error("DocVlmBackend: decoder output count mismatch");
    }
    past.clear();
    past.reserve(outputs.size() - 1);
    for (size_t i = 1; i < outputs.size(); ++i) past.push_back(std::move(outputs[i]));
    outputs.clear();
    return next;
  };

  std::vector<int64_t> mask(static_cast<size_t>(seq0), 1);
  int32_t next = 0;
  long long prefill_ms = 0;
  ctx.RunPhase(kOcrPhasePrefill, [&] {
    const auto t_prefill = std::chrono::steady_clock::now();
    auto prefill_out = run_decoder(embeds, seq0, mask);
    embeds.clear();
    embeds.shrink_to_fit();
    next = take_next(prefill_out, seq0);
    prefill_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                     std::chrono::steady_clock::now() - t_prefill)
                     .count();
  });

  std::vector<int32_t> generated_ids;
  int generated = 0;
  std::string stop_reason = "max_new_tokens";
  int step = 0;
  DocTagsPrefix prefix;
  auto snap_decode = [&]() {
    const int shown = generated > 0 ? generated : 1;
    ctx.Report(kOcrPhaseDecode, shown, shown);
  };
  ctx.ThrowIfCancelled();
  ctx.Report(kOcrPhaseDecode, 0, max_new);
  const auto t_decode = std::chrono::steady_clock::now();
  while (generated < max_new) {
    ctx.ThrowIfCancelled();
    ++step;
    const bool log_step = (step % 32 == 0);
    if (next == manifest_.eos_token_id) {
      stop_reason = "eos";
      OCR_LOGI("doc_vlm decode step=%d token=%d", step, next);
      snap_decode();
      break;
    }
    if (prompt_only_ids_.count(next) != 0) {
      stop_reason = "invalid_sequence";
      OCR_LOGI("doc_vlm decode step=%d token=%d", step, next);
      snap_decode();
      break;
    }
    const std::string piece = tokenizer_.Decode(std::vector<int32_t>{next});
    if (!prefix.Feed(piece)) {
      stop_reason = "invalid_sequence";
      OCR_LOGI("doc_vlm decode step=%d token=%d prefix_reject piece=%s", step,
               next, piece.c_str());
      snap_decode();
      break;
    }
    generated_ids.push_back(next);
    ++generated;
    ctx.Report(kOcrPhaseDecode, generated, max_new);
    if (next == doctag_end_id_) {
      stop_reason = "doctag_end";
      OCR_LOGI("doc_vlm decode step=%d token=%d", step, next);
      snap_decode();
      break;
    }
    if (generated == max_new) {
      stop_reason = "max_new_tokens";
      OCR_LOGI("doc_vlm decode step=%d token=%d", step, next);
      snap_decode();
      break;
    }
    if (log_step) OCR_LOGI("doc_vlm decode step=%d token=%d", step, next);

    std::vector<int64_t> one_id{next};
    const std::array<int64_t, 2> one_shape{1, 1};
    Ort::Value one = Ort::Value::CreateTensor<int64_t>(
        mem, one_id.data(), one_id.size(), one_shape.data(), one_shape.size());
    const char* in_names[] = {"input_ids"};
    const char* out_names[] = {"inputs_embeds"};
    auto embed_out = embed_session_->Run(Ort::RunOptions{nullptr}, in_names, &one, 1, out_names, 1);
    const float* row = embed_out[0].GetTensorData<float>();
    std::vector<float> one_embed(row, row + manifest_.hidden_size);
    embed_out.clear();

    const int64_t total = seq0 + generated;
    std::vector<int64_t> step_mask(static_cast<size_t>(total), 1);
    auto step_out = run_decoder(one_embed, 1, step_mask);
    next = take_next(step_out, 1);
  }
  const auto decode_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                             std::chrono::steady_clock::now() - t_decode)
                             .count();
  const double ms_per_token =
      generated > 0 ? static_cast<double>(decode_ms) / static_cast<double>(generated) : 0.0;

  OcrResult result;
  ctx.RunPhase(kOcrPhaseParse, [&] {
    result.doctags_utf8 = tokenizer_.Decode(generated_ids);
    LstripAsciiWs(result.doctags_utf8);
    result.raw_utf8 = result.doctags_utf8;
    DocTagsParse parsed =
        ParseDocTags(result.doctags_utf8, frame.width, frame.height, frame.frame_index);
    result.text_utf8 = std::move(parsed.text_utf8);
    result.markdown_utf8 = std::move(parsed.markdown_utf8);
    result.spans = std::move(parsed.spans);
  });
  result.stop_reason = stop_reason;
  result.complete = (stop_reason == "doctag_end");
  OCR_LOGI("doc_vlm decode_perf prefill_ms=%lld decode_ms=%lld generated=%d ms_per_token=%.2f",
           static_cast<long long>(prefill_ms), static_cast<long long>(decode_ms), generated,
           ms_per_token);
  OCR_LOGI("doc_vlm stop=%s complete=%d generated=%d text=%zu spans=%zu", stop_reason.c_str(),
           result.complete ? 1 : 0, generated, result.text_utf8.size(), result.spans.size());
  return result;
}

}  // namespace doc_vlm
}  // namespace ocr
}  // namespace sherpa_onnx
