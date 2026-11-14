#include <jni.h>
#include "jni/jni_utf8.h"

#include <cstdint>
#include <string>
#include <vector>

#include "ImageMmapThreshold.h"
#include "ImageRegistry.h"
#include "pdf/PdfFeatureGuard.h"
#include "pdf/PdfLazySession.h"
#include "pdf/PdfPageRasterizer.h"
#include "jni/document/doc_structure_summary_jni.h"
#include "pdf/PdfTextLayerExtractor.h"
#include "pdf/PdfTextPopulate.h"
#include "pdf/PdfTypes.h"

namespace {

jobject NewHashMap(JNIEnv* env, jmethodID* outPut) {
  jclass mapClass = env->FindClass("java/util/HashMap");
  if (!mapClass) return nullptr;
  jmethodID init = env->GetMethodID(mapClass, "<init>", "()V");
  jmethodID put = env->GetMethodID(
      mapClass, "put",
      "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
  if (!init || !put) {
    env->DeleteLocalRef(mapClass);
    return nullptr;
  }
  jobject map = env->NewObject(mapClass, init);
  env->DeleteLocalRef(mapClass);
  if (outPut) *outPut = put;
  return map;
}

void PutString(JNIEnv* env, jobject map, jmethodID put, const char* key,
               const std::string& value) {
  jstring jkey = env->NewStringUTF(key);
  jstring jval = sherpaonnx::NewJStringUtf8(env, value);
  env->CallObjectMethod(map, put, jkey, jval);
  env->DeleteLocalRef(jkey);
  env->DeleteLocalRef(jval);
}

void PutInt(JNIEnv* env, jobject map, jmethodID put, const char* key, jint value) {
  jclass intClass = env->FindClass("java/lang/Integer");
  jmethodID valueOf =
      env->GetStaticMethodID(intClass, "valueOf", "(I)Ljava/lang/Integer;");
  jobject boxed = env->CallStaticObjectMethod(intClass, valueOf, value);
  jstring jkey = env->NewStringUTF(key);
  env->CallObjectMethod(map, put, jkey, boxed);
  env->DeleteLocalRef(jkey);
  env->DeleteLocalRef(boxed);
  env->DeleteLocalRef(intClass);
}

void PutLong(JNIEnv* env, jobject map, jmethodID put, const char* key,
             jlong value) {
  jclass longClass = env->FindClass("java/lang/Long");
  jmethodID valueOf =
      env->GetStaticMethodID(longClass, "valueOf", "(J)Ljava/lang/Long;");
  jobject boxed = env->CallStaticObjectMethod(longClass, valueOf, value);
  jstring jkey = env->NewStringUTF(key);
  env->CallObjectMethod(map, put, jkey, boxed);
  env->DeleteLocalRef(jkey);
  env->DeleteLocalRef(boxed);
  env->DeleteLocalRef(longClass);
}

void PutBool(JNIEnv* env, jobject map, jmethodID put, const char* key,
             jboolean value) {
  jclass boolClass = env->FindClass("java/lang/Boolean");
  jmethodID valueOf =
      env->GetStaticMethodID(boolClass, "valueOf", "(Z)Ljava/lang/Boolean;");
  jobject boxed = env->CallStaticObjectMethod(boolClass, valueOf, value);
  jstring jkey = env->NewStringUTF(key);
  env->CallObjectMethod(map, put, jkey, boxed);
  env->DeleteLocalRef(jkey);
  env->DeleteLocalRef(boxed);
  env->DeleteLocalRef(boolClass);
}

std::string JstringToStd(JNIEnv* env, jstring js) {
  if (!js) return {};
  const char* c = env->GetStringUTFChars(js, nullptr);
  std::string s = c ? c : "";
  if (c) env->ReleaseStringUTFChars(js, c);
  return s;
}

}  // namespace

extern "C" {

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_pdf_PdfNative_nativeIsPdfiumEnabled(JNIEnv*, jclass) {
  return sherpa_onnx::pdf::IsPdfiumCompiledIn() ? JNI_TRUE : JNI_FALSE;
}

/**
 * Extract the PDF text layer straight into an empty offline text buffer (text,
 * line spans and, for layout "paragraphs", the reading structure; same path as
 * iOS). Returns HashMap: ok, errorCode?, errorMessage?, pageCount,
 * pagesWithText, utf16Length, spatialSpanCount, structure?.
 */
JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_pdf_PdfNative_nativeExtractTextLayer(
    JNIEnv* env,
    jclass,
    jstring jpath,
    jint fd,
    jintArray pagesOrNull,
    jstring passwordOrNull,
    jstring layoutOrNull,
    jstring textOutBufferId) {
  jmethodID put = nullptr;
  jobject map = NewHashMap(env, &put);
  if (!map) return nullptr;

  sherpa_onnx::pdf::ExtractOptions opts;
  if (pagesOrNull != nullptr) {
    const jsize pn = env->GetArrayLength(pagesOrNull);
    opts.pages.resize(static_cast<size_t>(pn));
    if (pn > 0) {
      env->GetIntArrayRegion(pagesOrNull, 0, pn, opts.pages.data());
    }
  }
  opts.password = JstringToStd(env, passwordOrNull);
  if (JstringToStd(env, layoutOrNull) == "paragraphs") {
    opts.layout = sherpa_onnx::pdf::PdfTextLayout::kParagraphs;
  }

  const auto result = sherpa_onnx::pdf::ExtractPdfTextLayer(
      sherpa_onnx::fileio::MakeSeekableSource(JstringToStd(env, jpath), fd),
      opts);
  if (!result.ok) {
    PutBool(env, map, put, "ok", JNI_FALSE);
    if (!result.error_code.empty()) PutString(env, map, put, "errorCode", result.error_code);
    if (!result.error_message.empty()) {
      PutString(env, map, put, "errorMessage", result.error_message);
    }
    return map;
  }
  std::string popErr;
  if (!sherpa_onnx::pdf::PopulateTextFromPdf(JstringToStd(env, textOutBufferId), result,
                                             &popErr)) {
    PutBool(env, map, put, "ok", JNI_FALSE);
    PutString(env, map, put, "errorCode", sherpa_onnx::pdf::kErrInvalidArgument);
    PutString(env, map, put, "errorMessage",
              popErr.empty() ? "Failed to populate text buffer" : popErr);
    return map;
  }
  int utf16 = 0;
  for (size_t i = 0; i < result.text.size(); ++i) {
    const unsigned char c = static_cast<unsigned char>(result.text[i]);
    if ((c & 0xC0u) != 0x80u) utf16 += c >= 0xF0 ? 2 : 1;
  }
  PutBool(env, map, put, "ok", JNI_TRUE);
  PutInt(env, map, put, "pageCount", result.page_count);
  PutInt(env, map, put, "pagesWithText", result.pages_with_text);
  PutInt(env, map, put, "utf16Length", utf16);
  PutInt(env, map, put, "spatialSpanCount", static_cast<jint>(result.spans.size()));
  if (result.structure) {
    jobject summary = sherpaonnx::NewStructureSummary(env, *result.structure);
    jstring jkey = env->NewStringUTF("structure");
    env->CallObjectMethod(map, put, jkey, summary);
    env->DeleteLocalRef(jkey);
    env->DeleteLocalRef(summary);
  }
  return map;
}

/**
 * Rasterize PDF pages into a new OfflineImageBuffer.
 * strategy: "rasterize-all" (default) or "lazy-lru".
 * hotFrames: only for lazy-lru (clamped in registry).
 * Returns HashMap:
 *   ok (Boolean), errorCode?, errorMessage?,
 *   bufferId, kind, state, frameCount, totalBytes, storageKind, pageCount
 */
JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_pdf_PdfNative_nativeRasterizePages(
    JNIEnv* env,
    jclass,
    jstring jpath,
    jint fd,
    jintArray pagesOrNull,
    jint dpi,
    jint maxSide,
    jstring strategyOrNull,
    jint hotFrames,
    jstring passwordOrNull) {
  jmethodID put = nullptr;
  jobject map = NewHashMap(env, &put);
  if (!map) return nullptr;

  const auto src =
      sherpa_onnx::fileio::MakeSeekableSource(JstringToStd(env, jpath), fd);

  std::vector<int> pages;
  if (pagesOrNull != nullptr) {
    const jsize pn = env->GetArrayLength(pagesOrNull);
    pages.resize(static_cast<size_t>(pn));
    if (pn > 0) {
      env->GetIntArrayRegion(pagesOrNull, 0, pn, pages.data());
    }
  }

  const int useDpi = dpi > 0 ? dpi : 144;
  const std::string password = JstringToStd(env, passwordOrNull);
  bool lazy = false;
  if (strategyOrNull != nullptr) {
    const char* raw = env->GetStringUTFChars(strategyOrNull, nullptr);
    if (raw) {
      lazy = std::string(raw) == "lazy-lru";
      env->ReleaseStringUTFChars(strategyOrNull, raw);
    }
  }

  if (lazy) {
    std::string err_code;
    std::string err_msg;
    auto session = sherpa_onnx::pdf::PdfLazySession::Open(
        src, useDpi, maxSide, &err_code, &err_msg,
        sherpa_onnx::pdf::PdfPasswordOrNull(password));
    if (!session) {
      PutBool(env, map, put, "ok", JNI_FALSE);
      PutString(
          env, map, put, "errorCode",
          err_code.empty() ? sherpa_onnx::pdf::kErrInternal : err_code);
      PutString(env, map, put, "errorMessage", err_msg);
      return map;
    }
    const int page_count = session->page_count();
    auto created =
        sherpa_onnx::image::ImageRegistry::Instance().CreateLazyPdfSlots(
            std::move(session), pages, hotFrames);
    if (!created.ok) {
      PutBool(env, map, put, "ok", JNI_FALSE);
      PutString(
          env, map, put, "errorCode",
          created.errorCode.empty() ? sherpa_onnx::pdf::kErrInternal
                                    : created.errorCode);
      PutString(env, map, put, "errorMessage", created.errorMessage);
      return map;
    }
    PutBool(env, map, put, "ok", JNI_TRUE);
    PutString(env, map, put, "bufferId", created.info.bufferId);
    PutString(env, map, put, "kind", "offlineImageBuffer");
    PutString(
        env, map, put, "state",
        sherpa_onnx::image::BufferStateName(created.info.state));
    PutInt(env, map, put, "frameCount", created.info.frameCount);
    PutLong(env, map, put, "totalBytes", created.info.totalBytes);
    PutString(
        env, map, put, "storageKind",
        sherpa_onnx::image::StorageKindName(created.info.storageKind));
    PutInt(env, map, put, "pageCount", page_count);
    return map;
  }

  sherpa_onnx::pdf::RasterOptions opts;
  opts.dpi = useDpi;
  opts.max_side = maxSide;
  opts.pages = std::move(pages);
  opts.password = password;

  auto raster = sherpa_onnx::pdf::RasterizePdfPages(src, opts);
  if (!raster.ok) {
    PutBool(env, map, put, "ok", JNI_FALSE);
    PutString(env, map, put, "errorCode", raster.error_code);
    PutString(env, map, put, "errorMessage", raster.error_message);
    return map;
  }

  auto created =
      sherpa_onnx::image::ImageRegistry::Instance().CreateFromRgbFrames(
          std::move(raster.frames),
          sherpa_onnx::image::ImageThresholdPathType::FileOrigin);
  if (!created.ok) {
    PutBool(env, map, put, "ok", JNI_FALSE);
    PutString(
        env,
        map,
        put,
        "errorCode",
        created.errorCode.empty() ? sherpa_onnx::pdf::kErrInternal
                                  : created.errorCode);
    PutString(env, map, put, "errorMessage", created.errorMessage);
    return map;
  }

  PutBool(env, map, put, "ok", JNI_TRUE);
  PutString(env, map, put, "bufferId", created.info.bufferId);
  PutString(env, map, put, "kind", "offlineImageBuffer");
  PutString(
      env, map, put, "state",
      sherpa_onnx::image::BufferStateName(created.info.state));
  PutInt(env, map, put, "frameCount", created.info.frameCount);
  PutLong(env, map, put, "totalBytes", created.info.totalBytes);
  PutString(
      env,
      map,
      put,
      "storageKind",
      sherpa_onnx::image::StorageKindName(created.info.storageKind));
  PutInt(env, map, put, "pageCount", raster.page_count);
  return map;
}

}  // extern "C"
