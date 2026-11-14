#include <jni.h>
#include "jni/jni_utf8.h"

#include <string>
#include <vector>

#include "reader/ReaderBridge.h"
#include "reader/ReaderFileHash.h"

namespace {

std::string Std(JNIEnv* env, jstring js) {
  if (!js) return {};
  const char* c = env->GetStringUTFChars(js, nullptr);
  std::string s = c ? c : "";
  if (c) env->ReleaseStringUTFChars(js, c);
  return s;
}

std::vector<std::string> StdStrings(JNIEnv* env, jobjectArray arr) {
  std::vector<std::string> out;
  if (!arr) return out;
  const jsize n = env->GetArrayLength(arr);
  out.reserve(n);
  for (jsize i = 0; i < n; ++i) {
    auto js = static_cast<jstring>(env->GetObjectArrayElement(arr, i));
    out.push_back(Std(env, js));
    env->DeleteLocalRef(js);
  }
  return out;
}

/** [ok ? json : code, ok ? "" : message] */
jobjectArray Result(JNIEnv* env, bool ok, const std::string& json,
                    const sherpa_onnx::reader::ReaderError& err) {
  jclass strCls = env->FindClass("java/lang/String");
  jobjectArray out = env->NewObjectArray(2, strCls, nullptr);
  env->DeleteLocalRef(strCls);
  jstring a = sherpaonnx::NewJStringUtf8(env, ok ? json : (err.code.empty() ? "ERR_READER_INVALID_ARGUMENT" : err.code));
  jstring b = sherpaonnx::NewJStringUtf8(env, ok ? std::string() : err.message);
  env->SetObjectArrayElement(out, 0, a);
  env->SetObjectArrayElement(out, 1, b);
  env->DeleteLocalRef(a);
  env->DeleteLocalRef(b);
  return out;
}

}  // namespace

extern "C" {

JNIEXPORT jobjectArray JNICALL
Java_com_sherpaonnx_reader_ReaderNative_nativeSha256OfSource(JNIEnv* env, jclass, jstring path,
                                                             jint fd) {
  sherpa_onnx::fileio::SeekableSource src;
  src.path = Std(env, path);
  src.fd = fd;
  std::string hex;
  std::string msg;
  sherpa_onnx::reader::ReaderError err;
  const bool ok = sherpa_onnx::reader::Sha256HexOfSource(src, &hex, &msg);
  if (!ok) {
    err.code = "ERR_READER_INVALID_ARGUMENT";
    err.message = msg;
  }
  return Result(env, ok, hex, err);
}

JNIEXPORT jobjectArray JNICALL
Java_com_sherpaonnx_reader_ReaderNative_nativeCreateDocument(JNIEnv* env, jclass, jstring textId,
                                                             jstring imageId, jstring key) {
  std::string json;
  sherpa_onnx::reader::ReaderError err;
  const bool ok = sherpa_onnx::reader::BridgeCreateDocument(Std(env, textId), Std(env, imageId),
                                                           Std(env, key), &json, &err);
  return Result(env, ok, json, err);
}

JNIEXPORT jobjectArray JNICALL
Java_com_sherpaonnx_reader_ReaderNative_nativeCreatePagesDocument(JNIEnv* env, jclass,
                                                                  jstring imageId, jstring key) {
  std::string json;
  sherpa_onnx::reader::ReaderError err;
  const bool ok = sherpa_onnx::reader::BridgeCreatePagesDocument(Std(env, imageId), Std(env, key),
                                                                &json, &err);
  return Result(env, ok, json, err);
}

JNIEXPORT jobjectArray JNICALL
Java_com_sherpaonnx_reader_ReaderNative_nativeInsertSection(
    JNIEnv* env, jclass, jstring docId, jstring after, jstring sectionId, jstring title,
    jobjectArray keys, jobjectArray types, jobjectArray texts, jintArray levels) {
  std::vector<int> lv;
  if (levels) {
    const jsize n = env->GetArrayLength(levels);
    lv.resize(n);
    env->GetIntArrayRegion(levels, 0, n, lv.data());
  }
  std::string json;
  sherpa_onnx::reader::ReaderError err;
  const bool ok = sherpa_onnx::reader::BridgeInsertSection(
      Std(env, docId), Std(env, after), Std(env, sectionId), Std(env, title),
      StdStrings(env, keys), StdStrings(env, types), StdStrings(env, texts), lv, &json, &err);
  return Result(env, ok, json, err);
}

JNIEXPORT jobjectArray JNICALL
Java_com_sherpaonnx_reader_ReaderNative_nativeRemoveSection(JNIEnv* env, jclass, jstring docId,
                                                            jstring sectionId) {
  std::string json;
  sherpa_onnx::reader::ReaderError err;
  const bool ok = sherpa_onnx::reader::BridgeRemoveSection(Std(env, docId), Std(env, sectionId),
                                                          &json, &err);
  return Result(env, ok, json, err);
}

JNIEXPORT jobjectArray JNICALL
Java_com_sherpaonnx_reader_ReaderNative_nativeGetBlocks(JNIEnv* env, jclass, jstring docId,
                                                        jint start, jint max,
                                                        jboolean includeText) {
  std::string json;
  sherpa_onnx::reader::ReaderError err;
  const bool ok = sherpa_onnx::reader::BridgeGetBlocks(Std(env, docId), start, max,
                                                      includeText == JNI_TRUE, &json, &err);
  return Result(env, ok, json, err);
}

JNIEXPORT jobjectArray JNICALL
Java_com_sherpaonnx_reader_ReaderNative_nativeFindBlockByHash(JNIEnv* env, jclass,
                                                              jstring docId, jstring hash,
                                                              jstring hint) {
  std::string json;
  sherpa_onnx::reader::ReaderError err;
  const bool ok = sherpa_onnx::reader::BridgeFindBlockByHash(Std(env, docId), Std(env, hash),
                                                            Std(env, hint), &json, &err);
  return Result(env, ok, json, err);
}

JNIEXPORT jobjectArray JNICALL
Java_com_sherpaonnx_reader_ReaderNative_nativeMapTextRanges(JNIEnv* env, jclass, jstring docId,
                                                            jintArray starts, jintArray ends) {
  auto read = [env](jintArray a) {
    std::vector<int> v;
    if (a) {
      v.resize(env->GetArrayLength(a));
      env->GetIntArrayRegion(a, 0, static_cast<jsize>(v.size()), v.data());
    }
    return v;
  };
  std::string json;
  sherpa_onnx::reader::ReaderError err;
  const bool ok = sherpa_onnx::reader::BridgeMapTextRanges(Std(env, docId), read(starts),
                                                          read(ends), &json, &err);
  return Result(env, ok, json, err);
}

JNIEXPORT jobjectArray JNICALL
Java_com_sherpaonnx_reader_ReaderNative_nativeGetToc(JNIEnv* env, jclass, jstring docId) {
  std::string json;
  sherpa_onnx::reader::ReaderError err;
  const bool ok = sherpa_onnx::reader::BridgeGetToc(Std(env, docId), &json, &err);
  return Result(env, ok, json, err);
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_reader_ReaderNative_nativeReleaseDocument(JNIEnv* env, jclass,
                                                              jstring docId) {
  return sherpa_onnx::reader::BridgeReleaseDocument(Std(env, docId)) ? JNI_TRUE : JNI_FALSE;
}

}  // extern "C"
