#pragma once

#include <jni.h>

#include <string>

#include "jni/jni_utf8.h"
#include "textbuffer/TxtStructure.h"

namespace sherpaonnx {

/**
 * Reading structure summary for JS as a java.util.HashMap (format, version,
 * blockCount, sections, metadata); blocks stay native. Shared by the document
 * and PDF bridges; mirrors the iOS SherpaDocStructureSummary.
 */
inline jobject NewStructureSummary(JNIEnv* env, const TxtStructure& st) {
  jclass mapCls = env->FindClass("java/util/HashMap");
  jmethodID mapInit = env->GetMethodID(mapCls, "<init>", "()V");
  jmethodID put =
      env->GetMethodID(mapCls, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
  jclass intCls = env->FindClass("java/lang/Integer");
  jmethodID intOf = env->GetStaticMethodID(intCls, "valueOf", "(I)Ljava/lang/Integer;");
  jclass listCls = env->FindClass("java/util/ArrayList");
  jmethodID listInit = env->GetMethodID(listCls, "<init>", "()V");
  jmethodID add = env->GetMethodID(listCls, "add", "(Ljava/lang/Object;)Z");

  auto putObj = [&](jobject map, const char* key, jobject value) {
    jstring jkey = env->NewStringUTF(key);
    env->CallObjectMethod(map, put, jkey, value);
    env->DeleteLocalRef(jkey);
    env->DeleteLocalRef(value);
  };
  auto putStr = [&](jobject map, const char* key, const std::string& value) {
    putObj(map, key, NewJStringUtf8(env, value));
  };
  auto putInt = [&](jobject map, const char* key, int value) {
    putObj(map, key, env->CallStaticObjectMethod(intCls, intOf, static_cast<jint>(value)));
  };

  jobject out = env->NewObject(mapCls, mapInit);
  putStr(out, "format", st.format);
  putInt(out, "version", st.version);
  putInt(out, "blockCount", static_cast<int>(st.blocks.size()));
  jobject sections = env->NewObject(listCls, listInit);
  for (const auto& sec : st.sections) {
    jobject m = env->NewObject(mapCls, mapInit);
    putInt(m, "sectionIndex", sec.sectionIndex);
    putStr(m, "href", sec.href);
    putStr(m, "kind", sec.kind);
    putStr(m, "titleSource", sec.titleSource);
    if (!sec.title.empty()) putStr(m, "title", sec.title);
    if (!sec.label.empty()) putStr(m, "label", sec.label);
    putInt(m, "utf16Start", sec.utf16Start);
    putInt(m, "utf16End", sec.utf16End);
    putInt(m, "firstBlock", sec.firstBlock);
    putInt(m, "blockCount", sec.blockCount);
    env->CallBooleanMethod(sections, add, m);
    env->DeleteLocalRef(m);
  }
  putObj(out, "sections", sections);
  jobject meta = env->NewObject(mapCls, mapInit);
  if (!st.title.empty()) putStr(meta, "title", st.title);
  if (!st.creator.empty()) putStr(meta, "creator", st.creator);
  if (!st.language.empty()) putStr(meta, "language", st.language);
  putObj(out, "metadata", meta);
  env->DeleteLocalRef(listCls);
  env->DeleteLocalRef(intCls);
  env->DeleteLocalRef(mapCls);
  return out;
}

}  // namespace sherpaonnx
