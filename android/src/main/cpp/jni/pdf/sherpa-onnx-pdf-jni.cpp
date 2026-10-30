#include <jni.h>

#include <cstdint>
#include <string>
#include <vector>

#include "ImageMmapThreshold.h"
#include "ImageRegistry.h"
#include "pdf/PdfFeatureGuard.h"
#include "pdf/PdfLazySession.h"
#include "pdf/PdfPageRasterizer.h"
#include "pdf/PdfTextLayerExtractor.h"
#include "pdf/PdfTypes.h"

namespace {

jstring JString(JNIEnv* env, const std::string& s) {
  return env->NewStringUTF(s.c_str());
}

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
  jstring jval = env->NewStringUTF(value.c_str());
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
 * Extract PDF text layer.
 * Returns a Java Object[]:
 *  [0] Boolean ok
 *  [1] String errorCode (nullable)
 *  [2] String errorMessage (nullable)
 *  [3] String text
 *  [4] Integer pageCount
 *  [5] Integer pagesWithText
 *  [6] Object[] spans — each Object[]:
 *      [0] utf16Start Int, [1] utf16End Int, [2] level String,
 *      [3] pageNumber Int, [4] pageWidth Float, [5] pageHeight Float,
 *      [6] frameIndex Int, [7] float[8] quad
 */
JNIEXPORT jobjectArray JNICALL
Java_com_sherpaonnx_pdf_PdfNative_nativeExtractTextLayer(
    JNIEnv* env,
    jclass,
    jstring jpath,
    jint fd,
    jintArray pagesOrNull,
    jstring passwordOrNull) {
  jclass objCls = env->FindClass("java/lang/Object");
  jclass boolCls = env->FindClass("java/lang/Boolean");
  jclass intCls = env->FindClass("java/lang/Integer");
  jclass floatCls = env->FindClass("java/lang/Float");
  jmethodID boolValueOf =
      env->GetStaticMethodID(boolCls, "valueOf", "(Z)Ljava/lang/Boolean;");
  jmethodID intValueOf =
      env->GetStaticMethodID(intCls, "valueOf", "(I)Ljava/lang/Integer;");
  jmethodID floatValueOf =
      env->GetStaticMethodID(floatCls, "valueOf", "(F)Ljava/lang/Float;");

  jobjectArray out = env->NewObjectArray(7, objCls, nullptr);

  sherpa_onnx::pdf::ExtractOptions opts;
  if (pagesOrNull != nullptr) {
    const jsize pn = env->GetArrayLength(pagesOrNull);
    opts.pages.resize(static_cast<size_t>(pn));
    if (pn > 0) {
      env->GetIntArrayRegion(pagesOrNull, 0, pn, opts.pages.data());
    }
  }
  opts.password = JstringToStd(env, passwordOrNull);

  const auto result = sherpa_onnx::pdf::ExtractPdfTextLayer(
      sherpa_onnx::fileio::MakeSeekableSource(JstringToStd(env, jpath), fd),
      opts);

  env->SetObjectArrayElement(
      out,
      0,
      env->CallStaticObjectMethod(
          boolCls, boolValueOf, result.ok ? JNI_TRUE : JNI_FALSE));
  if (!result.error_code.empty()) {
    env->SetObjectArrayElement(out, 1, JString(env, result.error_code));
  }
  if (!result.error_message.empty()) {
    env->SetObjectArrayElement(out, 2, JString(env, result.error_message));
  }
  env->SetObjectArrayElement(out, 3, JString(env, result.text));
  env->SetObjectArrayElement(
      out,
      4,
      env->CallStaticObjectMethod(intCls, intValueOf, result.page_count));
  env->SetObjectArrayElement(
      out,
      5,
      env->CallStaticObjectMethod(intCls, intValueOf, result.pages_with_text));

  jobjectArray spansArr =
      env->NewObjectArray(static_cast<jsize>(result.spans.size()), objCls, nullptr);
  for (size_t i = 0; i < result.spans.size(); ++i) {
    const auto& s = result.spans[i];
    jobjectArray one = env->NewObjectArray(8, objCls, nullptr);
    env->SetObjectArrayElement(
        one, 0, env->CallStaticObjectMethod(intCls, intValueOf, s.utf16_start));
    env->SetObjectArrayElement(
        one, 1, env->CallStaticObjectMethod(intCls, intValueOf, s.utf16_end));
    env->SetObjectArrayElement(one, 2, JString(env, s.level));
    env->SetObjectArrayElement(
        one,
        3,
        env->CallStaticObjectMethod(intCls, intValueOf, s.page_number));
    env->SetObjectArrayElement(
        one,
        4,
        env->CallStaticObjectMethod(floatCls, floatValueOf, s.page_width));
    env->SetObjectArrayElement(
        one,
        5,
        env->CallStaticObjectMethod(floatCls, floatValueOf, s.page_height));
    env->SetObjectArrayElement(
        one,
        6,
        env->CallStaticObjectMethod(intCls, intValueOf, s.frame_index));
    jfloatArray quad = env->NewFloatArray(8);
    env->SetFloatArrayRegion(quad, 0, 8, s.quad);
    env->SetObjectArrayElement(one, 7, quad);
    env->SetObjectArrayElement(spansArr, static_cast<jsize>(i), one);
  }
  env->SetObjectArrayElement(out, 6, spansArr);
  return out;
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
