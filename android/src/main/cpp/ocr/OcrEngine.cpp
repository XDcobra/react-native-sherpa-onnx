#include "OcrEngine.h"

#include "OcrDetect.h"
#include "OcrFactory.h"
#include "OcrTextUtils.h"
#include "ImageRegistry.h"
#include "ImageTypes.h"

#include <stdexcept>

#ifndef OCR_LOG_TAG
#define OCR_LOG_TAG "SherpaOnnx:ocr"
#endif

#if defined(__ANDROID__)
#include <android/log.h>
#define OCR_LOGI(...) __android_log_print(ANDROID_LOG_INFO, OCR_LOG_TAG, __VA_ARGS__)
#define OCR_LOGW(...) __android_log_print(ANDROID_LOG_WARN, OCR_LOG_TAG, __VA_ARGS__)
#define OCR_LOGE(...) __android_log_print(ANDROID_LOG_ERROR, OCR_LOG_TAG, __VA_ARGS__)
#else
#include <cstdio>
#define OCR_LOGI(...)             \
  do {                            \
    std::fprintf(stderr, "[SherpaOnnx:ocr] "); \
    std::fprintf(stderr, __VA_ARGS__);         \
    std::fprintf(stderr, "\n");                \
  } while (0)
#define OCR_LOGW(...) OCR_LOGI(__VA_ARGS__)
#define OCR_LOGE(...) OCR_LOGI(__VA_ARGS__)
#endif

namespace sherpa_onnx {
namespace ocr {
namespace {

OcrSpanLevel GranularityToLevel(OcrGranularity g) {
  switch (g) {
    case OcrGranularity::kWord:
      return OcrSpanLevel::kWord;
    case OcrGranularity::kBlock:
      return OcrSpanLevel::kBlock;
    case OcrGranularity::kLine:
    default:
      return OcrSpanLevel::kLine;
  }
}

void FilterSpansByGranularity(OcrResult& result, OcrGranularity granularity) {
  const OcrSpanLevel want = GranularityToLevel(granularity);
  std::vector<OcrSpan> kept;
  kept.reserve(result.spans.size());
  for (const auto& span : result.spans) {
    if (span.level == want) {
      kept.push_back(span);
    }
  }
  result.spans = std::move(kept);
}

bool HasCustomOcrPaths(const OcrLoadOptions& options) {
  return !options.path_det.empty() || !options.path_rec.empty() ||
         !options.path_cls.empty() || !options.path_rec_dict.empty() ||
         !options.path_manifest.empty() ||
         !options.path_vision_encoder.empty() ||
         !options.path_vision_encoder_data.empty() ||
         !options.path_embed_tokens.empty() ||
         !options.path_embed_tokens_data.empty() ||
         !options.path_decoder.empty() || !options.path_decoder_data.empty() ||
         !options.path_tokenizer.empty() || !options.path_patch_embed.empty() ||
         !options.path_patch_embed_data.empty() ||
         !options.path_pos_embed.empty() || !options.path_embedding.empty() ||
         !options.path_embedding_data.empty();
}

void CopyDetectPaths(OcrLoadOptions& options, const OcrDetectResult& detect) {
  options.path_det = detect.detPath;
  options.path_rec = detect.recPath;
  options.path_cls = detect.clsPath;
  options.path_rec_dict = detect.recDictPath;
  options.path_manifest = detect.manifestPath;
  options.path_vision_encoder = detect.visionEncoderPath;
  options.path_vision_encoder_data = detect.visionEncoderDataPath;
  options.path_embed_tokens = detect.embedTokensPath;
  options.path_embed_tokens_data = detect.embedTokensDataPath;
  options.path_decoder = detect.decoderPath;
  options.path_decoder_data = detect.decoderDataPath;
  options.path_tokenizer = detect.tokenizerPath;
  options.path_embedding = detect.embeddingPath;
  options.path_embedding_data = detect.embeddingDataPath;
  options.path_patch_embed = detect.patchEmbedPath;
  options.path_patch_embed_data = detect.patchEmbedDataPath;
  options.path_pos_embed = detect.posEmbedPath;
}

}  // namespace

void OcrEngine::Load(const std::string& model_type, const std::string& model_dir,
                     const OcrLoadOptions& options) {
  std::lock_guard<std::mutex> lock(mutex_);
  Release();
  options_ = options;

  std::string resolved = model_type.empty() ? "auto" : model_type;
  if (!HasCustomOcrPaths(options_)) {
    auto detect = DetectOcrModel(model_dir, resolved, options_.quantization);
    if (!detect.ok) {
      throw std::runtime_error(detect.errorMessage.empty()
                                   ? "OCR auto-detect failed"
                                   : detect.errorMessage);
    }
    resolved = detect.modelType;
    CopyDetectPaths(options_, detect);
    OCR_LOGI("detect → family=%s modelType=%s quant=%s dir=%s",
             detect.family.c_str(), resolved.c_str(),
             options_.quantization.c_str(), model_dir.c_str());
  }

  backend_ = CreateOcrBackend(resolved);
  try {
    backend_->Load(model_dir, options_);
  } catch (const std::exception& e) {
    OCR_LOGE("load failed family=%s provider=%s dir=%s: %s", backend_->Family(),
             options_.provider.empty() ? "cpu" : options_.provider.c_str(),
             model_dir.c_str(), e.what() ? e.what() : "unknown");
    backend_.reset();
    throw;
  }
  OCR_LOGI(
      "loaded family=%s provider=%s threads=%d maxSide=%d maxNew=%d maxPixels=%d "
      "paddleocr_vl_task=%s dir=%s",
      backend_->Family(),
      options_.provider.empty() ? "cpu" : options_.provider.c_str(),
      options_.num_threads, options_.max_side_len, options_.max_new_tokens,
      options_.max_pixels,
      options_.paddleocr_vl_task.empty() ? "ocr"
                                         : options_.paddleocr_vl_task.c_str(),
      model_dir.c_str());
}

const char* OcrEngine::Family() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return backend_ ? backend_->Family() : "";
}

void OcrEngine::Release() {
  if (backend_) {
    backend_->Release();
    backend_.reset();
  }
}

OcrEngine::RecognizeOutcome OcrEngine::RecognizeMulti(
    const std::string& image_buffer_id, const RecognizeOptions& options) {
  RecognizeOutcome out;
  std::unique_lock<std::mutex> lock(mutex_);
  if (!backend_) {
    out.errorCode = "OCR_NOT_INITIALIZED";
    out.errorMessage = "OCR engine is not loaded";
    return out;
  }
  out.family = backend_->Family() ? backend_->Family() : "";

  if (options.has_paddleocr_vl && out.family != "paddleocr_vl") {
    out.errorCode = "OCR_INVALID_ARGUMENT";
    out.errorMessage = "paddleocrVl is only valid for paddleocr_vl";
    return out;
  }
  if (!options.paddleocr_vl_task.empty() &&
      options.paddleocr_vl_task != "ocr" &&
      options.paddleocr_vl_task != "spotting") {
    out.errorCode = "OCR_INVALID_ARGUMENT";
    out.errorMessage = "paddleocrVl.task must be 'ocr' or 'spotting'";
    return out;
  }

  image::ImageBufferInfo info;
  if (!image::ImageRegistry::Instance().GetInfo(image_buffer_id, info)) {
    out.errorCode = "OCR_IMAGE_BUFFER_NOT_FOUND";
    out.errorMessage = "Image buffer not found: " + image_buffer_id;
    return out;
  }
  if (info.frameCount <= 0) {
    out.errorCode = "OCR_IMAGE_BUFFER_EMPTY";
    out.errorMessage = "Image buffer has no frames: " + image_buffer_id;
    return out;
  }

  std::vector<int> frames = options.frame_indices;
  if (frames.empty()) {
    frames.reserve(info.frameCount);
    for (int i = 0; i < info.frameCount; ++i) {
      frames.push_back(i);
    }
  }

  const int total = static_cast<int>(frames.size());
  OCR_LOGI("recognize start buffer=%s frames=%d family=%s", image_buffer_id.c_str(),
           total, out.family.c_str());

  OcrResult merged;
  int utf16_cursor = 0;
  int done = 0;

  auto appendField = [](std::string& dest, const std::string& chunk) {
    if (chunk.empty()) return;
    if (!dest.empty()) dest.push_back('\n');
    dest += chunk;
  };

  for (int frame_index : frames) {
    if (options.cancel && options.cancel()) {
      out.cancelled = true;
      out.errorCode = "OCR_CANCELLED";
      out.errorMessage = "OCR recognize cancelled";
      OCR_LOGI("recognize cancelled after %d/%d", done, total);
      return out;
    }
    if (frame_index < 0 || frame_index >= info.frameCount) {
      out.errorCode = "OCR_INVALID_ARGUMENT";
      out.errorMessage = "frameIndex out of range: " + std::to_string(frame_index);
      return out;
    }

    int width = 0;
    int height = 0;
    const uint8_t* rgb = image::ImageRegistry::Instance().GetFrameRgbPtr(
        image_buffer_id, frame_index, &width, &height);
    if (!rgb || width <= 0 || height <= 0) {
      out.errorCode = "OCR_FRAME_READ_FAILED";
      out.errorMessage =
          "Failed to get RGB ptr for frame " + std::to_string(frame_index);
      return out;
    }

    OcrFrameView view;
    view.rgb = rgb;
    view.width = width;
    view.height = height;
    view.frame_index = frame_index;

    OcrRecognizeContext ctx;
    ctx.progress = options.progress;
    ctx.cancel = options.cancel;
    ctx.frame_index = frame_index;
    ctx.frame_count = total;
    ctx.progress_min_interval_ms = options.progress_min_interval_ms;
    ctx.paddleocr_vl_task = options.paddleocr_vl_task.empty()
                                ? options_.paddleocr_vl_task
                                : options.paddleocr_vl_task;

    OcrResult frame_result;
    try {
      // Backend may run for a while; keep lock so unload cannot race Release.
      frame_result = backend_->Recognize(view, ctx);
    } catch (const OcrCancelled&) {
      out.cancelled = true;
      out.errorCode = "OCR_CANCELLED";
      out.errorMessage = "OCR recognize cancelled";
      OCR_LOGI("recognize cancelled in backend after %d/%d", done, total);
      return out;
    } catch (const std::exception& e) {
      out.errorCode = "OCR_RECOGNIZE_FAILED";
      out.errorMessage = e.what() ? e.what() : "recognize failed";
      return out;
    }

    if (!merged.text_utf8.empty() && !frame_result.text_utf8.empty()) {
      merged.text_utf8.push_back('\n');
      utf16_cursor += 1;
    }

    for (auto span : frame_result.spans) {
      span.utf16_start += utf16_cursor;
      span.utf16_end += utf16_cursor;
      span.frame_index = frame_index;
      merged.spans.push_back(span);
    }
    merged.text_utf8 += frame_result.text_utf8;
    utf16_cursor += Utf8ToUtf16Length(frame_result.text_utf8);
    appendField(merged.doctags_utf8, frame_result.doctags_utf8);
    appendField(merged.raw_utf8, frame_result.raw_utf8);
    appendField(merged.markdown_utf8, frame_result.markdown_utf8);
    merged.stop_reason = frame_result.stop_reason;
    merged.complete = frame_result.complete;
    OCR_LOGI(
        "recognize extras frame=%d stop=%s complete=%d doctags=%zu raw=%zu "
        "markdown=%zu",
        frame_index, frame_result.stop_reason.c_str(),
        frame_result.complete ? 1 : 0, frame_result.doctags_utf8.size(),
        frame_result.raw_utf8.size(), frame_result.markdown_utf8.size());

    ++done;
  }

  FilterSpansByGranularity(merged, options.granularity);
  out.ok = true;
  out.result = std::move(merged);
  OCR_LOGI(
      "recognize done buffer=%s spans=%zu textUtf16≈%d doctags=%zu raw=%zu "
      "markdown=%zu stop=%s complete=%d",
      image_buffer_id.c_str(), out.result.spans.size(), utf16_cursor,
      out.result.doctags_utf8.size(), out.result.raw_utf8.size(),
      out.result.markdown_utf8.size(),
      out.result.stop_reason.c_str(), out.result.complete ? 1 : 0);
  return out;
}

OcrEngineRegistry& OcrEngineRegistry::Instance() {
  static OcrEngineRegistry inst;
  return inst;
}

OcrEngine& OcrEngineRegistry::Create(const std::string& instance_id) {
  std::lock_guard<std::mutex> lock(mutex_);
  auto& slot = engines_[instance_id];
  slot = std::make_unique<OcrEngine>();
  return *slot;
}

OcrEngine* OcrEngineRegistry::Get(const std::string& instance_id) {
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = engines_.find(instance_id);
  if (it == engines_.end()) return nullptr;
  return it->second.get();
}

bool OcrEngineRegistry::Destroy(const std::string& instance_id) {
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = engines_.find(instance_id);
  if (it == engines_.end()) return false;
  if (it->second) {
    it->second->Release();
  }
  engines_.erase(it);
  return true;
}

OcrCancelRegistry& OcrCancelRegistry::Instance() {
  static OcrCancelRegistry inst;
  return inst;
}

void OcrCancelRegistry::Begin(const std::string& operation_id) {
  if (operation_id.empty()) return;
  std::lock_guard<std::mutex> lock(mutex_);
  flags_[operation_id] = std::make_shared<std::atomic<bool>>(false);
}

void OcrCancelRegistry::RequestCancel(const std::string& operation_id) {
  if (operation_id.empty()) return;
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = flags_.find(operation_id);
  if (it != flags_.end() && it->second) {
    it->second->store(true);
    OCR_LOGI("cancel requested op=%s", operation_id.c_str());
  }
}

bool OcrCancelRegistry::IsCancelled(const std::string& operation_id) const {
  if (operation_id.empty()) return false;
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = flags_.find(operation_id);
  if (it == flags_.end() || !it->second) return false;
  return it->second->load();
}

void OcrCancelRegistry::End(const std::string& operation_id) {
  if (operation_id.empty()) return;
  std::lock_guard<std::mutex> lock(mutex_);
  flags_.erase(operation_id);
}

}  // namespace ocr
}  // namespace sherpa_onnx
