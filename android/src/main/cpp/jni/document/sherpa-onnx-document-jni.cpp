#include <jni.h>
#include "jni/jni_utf8.h"

#include <string>
#include <vector>

#include "DocTextPopulate.h"
#include "DocumentExtractor.h"
#include "ImageMmapThreshold.h"
#include "ImageRegistry.h"

namespace {

std::string JstringToStd(JNIEnv* env, jstring js) {
  if (!js) return {};
  const char* c = env->GetStringUTFChars(js, nullptr);
  std::string s = c ? c : "";
  if (c) env->ReleaseStringUTFChars(js, c);
  return s;
}

jobject NewHashMap(JNIEnv* env, jmethodID* outPut) {
  jclass mapClass = env->FindClass("java/util/HashMap");
  jmethodID init = env->GetMethodID(mapClass, "<init>", "()V");
  jmethodID put = env->GetMethodID(
      mapClass, "put",
      "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
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

void PutInt(JNIEnv* env, jobject map, jmethodID put, const char* key, jint v) {
  jclass intClass = env->FindClass("java/lang/Integer");
  jmethodID valueOf =
      env->GetStaticMethodID(intClass, "valueOf", "(I)Ljava/lang/Integer;");
  jobject boxed = env->CallStaticObjectMethod(intClass, valueOf, v);
  jstring jkey = env->NewStringUTF(key);
  env->CallObjectMethod(map, put, jkey, boxed);
  env->DeleteLocalRef(jkey);
  env->DeleteLocalRef(boxed);
  env->DeleteLocalRef(intClass);
}

void PutBool(JNIEnv* env, jobject map, jmethodID put, const char* key,
             jboolean v) {
  jclass boolClass = env->FindClass("java/lang/Boolean");
  jmethodID valueOf =
      env->GetStaticMethodID(boolClass, "valueOf", "(Z)Ljava/lang/Boolean;");
  jobject boxed = env->CallStaticObjectMethod(boolClass, valueOf, v);
  jstring jkey = env->NewStringUTF(key);
  env->CallObjectMethod(map, put, jkey, boxed);
  env->DeleteLocalRef(jkey);
  env->DeleteLocalRef(boxed);
  env->DeleteLocalRef(boolClass);
}

void PutObject(JNIEnv* env, jobject map, jmethodID put, const char* key,
               jobject value) {
  jstring jkey = env->NewStringUTF(key);
  env->CallObjectMethod(map, put, jkey, value);
  env->DeleteLocalRef(jkey);
}

/** Structure summary for JS (sections + metadata; blocks stay native). */
jobject StructureSummary(JNIEnv* env, const TxtStructure& st) {
  jmethodID put = nullptr;
  jobject out = NewHashMap(env, &put);
  PutInt(env, out, put, "version", st.version);
  PutInt(env, out, put, "blockCount", static_cast<jint>(st.blocks.size()));
  jclass listCls = env->FindClass("java/util/ArrayList");
  jmethodID listInit = env->GetMethodID(listCls, "<init>", "()V");
  jmethodID add = env->GetMethodID(listCls, "add", "(Ljava/lang/Object;)Z");
  jobject sections = env->NewObject(listCls, listInit);
  for (const auto& sec : st.sections) {
    jmethodID sput = nullptr;
    jobject m = NewHashMap(env, &sput);
    PutInt(env, m, sput, "sectionIndex", sec.sectionIndex);
    PutString(env, m, sput, "href", sec.href);
    PutString(env, m, sput, "kind", sec.kind);
    PutString(env, m, sput, "titleSource", sec.titleSource);
    if (!sec.title.empty()) PutString(env, m, sput, "title", sec.title);
    PutInt(env, m, sput, "utf16Start", sec.utf16Start);
    PutInt(env, m, sput, "utf16End", sec.utf16End);
    PutInt(env, m, sput, "firstBlock", sec.firstBlock);
    PutInt(env, m, sput, "blockCount", sec.blockCount);
    env->CallBooleanMethod(sections, add, m);
    env->DeleteLocalRef(m);
  }
  PutObject(env, out, put, "sections", sections);
  env->DeleteLocalRef(sections);
  env->DeleteLocalRef(listCls);
  jmethodID mput = nullptr;
  jobject meta = NewHashMap(env, &mput);
  if (!st.title.empty()) PutString(env, meta, mput, "title", st.title);
  if (!st.creator.empty()) PutString(env, meta, mput, "creator", st.creator);
  if (!st.language.empty()) PutString(env, meta, mput, "language", st.language);
  PutObject(env, out, put, "metadata", meta);
  env->DeleteLocalRef(meta);
  return out;
}

jobject SectionList(JNIEnv* env, const std::vector<sherpa_onnx::document::DocSection>& secs) {
  jclass arrayListCls = env->FindClass("java/util/ArrayList");
  jmethodID init = env->GetMethodID(arrayListCls, "<init>", "()V");
  jmethodID add =
      env->GetMethodID(arrayListCls, "add", "(Ljava/lang/Object;)Z");
  jobject list = env->NewObject(arrayListCls, init);
  for (const auto& s : secs) {
    jmethodID put = nullptr;
    jobject m = NewHashMap(env, &put);
    PutInt(env, m, put, "sectionIndex", s.section_index);
    if (!s.href.empty()) PutString(env, m, put, "href", s.href);
    PutString(env, m, put, "kind", s.kind);
    env->CallBooleanMethod(list, add, m);
    env->DeleteLocalRef(m);
  }
  env->DeleteLocalRef(arrayListCls);
  return list;
}

void BindProgress(JNIEnv* env, jobject listener,
                  sherpa_onnx::document::ExtractOptions* opt) {
  if (!env || !listener || !opt) return;
  jclass cls = env->GetObjectClass(listener);
  jmethodID mid =
      env->GetMethodID(cls, "onProgress", "(IILjava/lang/String;)V");
  env->DeleteLocalRef(cls);
  if (!mid) return;
  opt->on_progress = [env, listener, mid](int done, int total, const char* phase) {
    jstring jphase = sherpaonnx::NewJStringUtf8(env, phase ? phase : "");
    env->CallVoidMethod(listener, mid, static_cast<jint>(done),
                        static_cast<jint>(total), jphase);
    env->DeleteLocalRef(jphase);
    if (env->ExceptionCheck()) {
      env->ExceptionClear();
    }
  };
}

}  // namespace

extern "C" {

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_document_DocumentNative_nativeExtractTextInto(
    JNIEnv* env, jclass, jstring jpath, jint fd, jstring jbufferId,
    jobject progress) {
  jmethodID put = nullptr;
  jobject map = NewHashMap(env, &put);
  const auto src =
      sherpa_onnx::fileio::MakeSeekableSource(JstringToStd(env, jpath), fd);
  sherpa_onnx::document::ExtractOptions opt;
  BindProgress(env, progress, &opt);
  const auto result = sherpa_onnx::document::ExtractDocumentText(src, opt);
  if (!result.ok) {
    PutBool(env, map, put, "ok", JNI_FALSE);
    if (!result.error_code.empty()) PutString(env, map, put, "errorCode", result.error_code);
    if (!result.error_message.empty()) {
      PutString(env, map, put, "errorMessage", result.error_message);
    }
    return map;
  }
  // Text, markup spans and structure go straight into the native text buffer
  // (same path as iOS); only a summary crosses JNI.
  std::string popErr;
  if (!sherpa_onnx::document::PopulateTextBufferFromDocument(
          JstringToStd(env, jbufferId), result, &popErr)) {
    PutBool(env, map, put, "ok", JNI_FALSE);
    PutString(env, map, put, "errorCode", "ERR_DOC_INVALID_ARGUMENT");
    PutString(env, map, put, "errorMessage",
              popErr.empty() ? "Failed to populate text buffer" : popErr);
    return map;
  }
  PutBool(env, map, put, "ok", JNI_TRUE);
  PutString(env, map, put, "format", result.format);
  PutInt(env, map, put, "sectionCount",
         static_cast<jint>(result.sections.size()));
  PutInt(env, map, put, "spatialSpanCount",
         static_cast<jint>(result.spans.size()));
  jobject sections = SectionList(env, result.sections);
  jobject imageOnly = SectionList(env, result.image_only_sections);
  PutObject(env, map, put, "sections", sections);
  PutObject(env, map, put, "imageOnlySections", imageOnly);
  env->DeleteLocalRef(sections);
  env->DeleteLocalRef(imageOnly);
  if (result.structure) {
    jobject summary = StructureSummary(env, *result.structure);
    PutObject(env, map, put, "structure", summary);
    env->DeleteLocalRef(summary);
  }
  return map;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_document_DocumentNative_nativeExtractImages(
    JNIEnv* env, jclass, jstring jpath, jint fd, jint maxSide, jobject progress) {
  jmethodID put = nullptr;
  jobject map = NewHashMap(env, &put);
  sherpa_onnx::document::ExtractOptions opt;
  opt.max_side = maxSide;
  BindProgress(env, progress, &opt);
  const auto src =
      sherpa_onnx::fileio::MakeSeekableSource(JstringToStd(env, jpath), fd);
  auto result = sherpa_onnx::document::ExtractDocumentImages(src, opt);
  PutBool(env, map, put, "ok", result.ok ? JNI_TRUE : JNI_FALSE);
  if (!result.error_code.empty()) PutString(env, map, put, "errorCode", result.error_code);
  if (!result.error_message.empty()) {
    PutString(env, map, put, "errorMessage", result.error_message);
  }
  PutString(env, map, put, "format", result.format);
  if (!result.ok) {
    PutInt(env, map, put, "frameCount", 0);
    return map;
  }
  std::vector<sherpa_onnx::image::RgbFrame> frames;
  frames.reserve(result.frames.size());
  for (auto& fr : result.frames) {
    fr.rgb.sectionIndex = fr.section_index;
    fr.rgb.href = fr.href;
    fr.rgb.pageNumber = fr.page_number;
    frames.push_back(std::move(fr.rgb));
  }
  auto created = sherpa_onnx::image::ImageRegistry::Instance().CreateFromRgbFrames(
      std::move(frames), sherpa_onnx::image::ImageThresholdPathType::FileOrigin);
  if (!created.ok) {
    PutBool(env, map, put, "ok", JNI_FALSE);
    PutString(env, map, put, "errorCode",
              created.errorCode.empty() ? "ERR_DOC_OPEN_FAILED" : created.errorCode);
    PutString(env, map, put, "errorMessage", created.errorMessage);
    return map;
  }
  PutString(env, map, put, "bufferId", created.bufferId);
  PutInt(env, map, put, "frameCount", created.info.frameCount);
  return map;
}

}  // namespace
