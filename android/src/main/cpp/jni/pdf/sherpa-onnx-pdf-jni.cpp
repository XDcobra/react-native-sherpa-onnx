#include <jni.h>

#include <cstdint>
#include <string>
#include <vector>

#include "pdf/PdfFeatureGuard.h"
#include "pdf/PdfTextLayerExtractor.h"
#include "pdf/PdfTypes.h"

namespace {

jstring JString(JNIEnv* env, const std::string& s) {
  return env->NewStringUTF(s.c_str());
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
    jbyteArray pdfBytes,
    jintArray pagesOrNull) {
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

  if (pdfBytes == nullptr) {
    env->SetObjectArrayElement(
        out, 0, env->CallStaticObjectMethod(boolCls, boolValueOf, JNI_FALSE));
    env->SetObjectArrayElement(
        out, 1, JString(env, sherpa_onnx::pdf::kErrInvalidArgument));
    env->SetObjectArrayElement(out, 2, JString(env, "PDF bytes required"));
    env->SetObjectArrayElement(out, 3, JString(env, ""));
    env->SetObjectArrayElement(
        out, 4, env->CallStaticObjectMethod(intCls, intValueOf, 0));
    env->SetObjectArrayElement(
        out, 5, env->CallStaticObjectMethod(intCls, intValueOf, 0));
    env->SetObjectArrayElement(out, 6, env->NewObjectArray(0, objCls, nullptr));
    return out;
  }

  const jsize n = env->GetArrayLength(pdfBytes);
  std::vector<uint8_t> bytes(static_cast<size_t>(n));
  if (n > 0) {
    env->GetByteArrayRegion(
        pdfBytes, 0, n, reinterpret_cast<jbyte*>(bytes.data()));
  }

  sherpa_onnx::pdf::ExtractOptions opts;
  if (pagesOrNull != nullptr) {
    const jsize pn = env->GetArrayLength(pagesOrNull);
    opts.pages.resize(static_cast<size_t>(pn));
    if (pn > 0) {
      env->GetIntArrayRegion(pagesOrNull, 0, pn, opts.pages.data());
    }
  }

  const auto result = sherpa_onnx::pdf::ExtractPdfTextLayer(
      bytes.data(), bytes.size(), opts);

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

}  // extern "C"
