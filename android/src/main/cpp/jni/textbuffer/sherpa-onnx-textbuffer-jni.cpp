#include <jni.h>

#include "TextRegistry.h"

#include <string>
#include <vector>

namespace {

std::string jstringToUtf8(JNIEnv *env, jstring s) {
  if (!s) return {};
  const char *chars = env->GetStringUTFChars(s, nullptr);
  std::string out = chars ? chars : "";
  if (chars) env->ReleaseStringUTFChars(s, chars);
  return out;
}

jstring utf8ToJstring(JNIEnv *env, const std::string &s) { return env->NewStringUTF(s.c_str()); }

}  // namespace

extern "C" {

JNIEXPORT void JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeInit(JNIEnv *env, jclass, jstring cacheDir) {
  txt_configure_cache_dir(jstringToUtf8(env, cacheDir));
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeCreateEmptyOffline(JNIEnv *env, jclass) {
  std::string id, err;
  if (!txt_create_empty_offline(&id, &err)) return nullptr;
  return utf8ToJstring(env, id);
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeCreateOfflineFromText(
    JNIEnv *env, jclass, jstring text, jstring lang, jstring emotion, jstring event) {
  std::string id, err;
  if (!txt_create_offline_from_text(jstringToUtf8(env, text), jstringToUtf8(env, lang),
                                    jstringToUtf8(env, emotion), jstringToUtf8(env, event), &id,
                                    &err)) {
    return nullptr;
  }
  return utf8ToJstring(env, id);
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeCreateLive(
    JNIEnv *env, jclass, jint windowMaxChars, jint maxSegments, jboolean emitPartial,
    jlong partialMinIntervalMs, jstring spoolMode, jstring spoolPath, jboolean spoolTemporary) {
  std::string id, err;
  if (!txt_create_live(windowMaxChars, maxSegments, emitPartial == JNI_TRUE,
                       (int64_t)partialMinIntervalMs, jstringToUtf8(env, spoolMode),
                       jstringToUtf8(env, spoolPath), spoolTemporary == JNI_TRUE, &id, &err)) {
    return nullptr;
  }
  return utf8ToJstring(env, id);
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeWritePartial(JNIEnv *env, jclass,
                                                                      jstring liveId,
                                                                      jstring text) {
  auto live = txt_get_live_entry(jstringToUtf8(env, liveId));
  std::string err;
  return txt_live_write_partial(live, jstringToUtf8(env, text), &err) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeCommitSegment(
    JNIEnv *env, jclass, jstring liveId, jstring text, jstring source, jstring metaJson) {
  auto live = txt_get_live_entry(jstringToUtf8(env, liveId));
  if (!live) return -1;
  try {
    return live->commitSegment(jstringToUtf8(env, text), {}, {}, jstringToUtf8(env, source),
                               jstringToUtf8(env, metaJson));
  } catch (...) {
    return -1;
  }
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeFinalizeLive(JNIEnv *env, jclass,
                                                                      jstring liveId) {
  std::string err;
  return txt_finalize_live(jstringToUtf8(env, liveId), &err) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeRelease(JNIEnv *env, jclass,
                                                                 jstring bufferId) {
  return txt_release_buffer(jstringToUtf8(env, bufferId)) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeReadOfflineText(JNIEnv *env, jclass,
                                                                         jstring bufferId) {
  std::string text, err;
  if (!txt_read_offline_text(jstringToUtf8(env, bufferId), &text, &err)) return nullptr;
  return utf8ToJstring(env, text);
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativePopulateIfEmpty(
    JNIEnv *env, jclass, jstring bufferId, jstring text, jstring lang, jstring emotion,
    jstring event) {
  std::string err;
  return txt_populate_offline_if_empty(jstringToUtf8(env, bufferId), jstringToUtf8(env, text), {},
                                       {}, {}, jstringToUtf8(env, lang),
                                       jstringToUtf8(env, emotion), jstringToUtf8(env, event),
                                       &err)
             ? JNI_TRUE
             : JNI_FALSE;
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeCreateOfflineFromLive(
    JNIEnv *env, jclass, jstring liveId, jstring mode) {
  std::string id, err;
  if (!txt_create_offline_from_live(jstringToUtf8(env, liveId), jstringToUtf8(env, mode), &id,
                                    &err)) {
    return nullptr;
  }
  return utf8ToJstring(env, id);
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeLiveSnapshot(JNIEnv *env, jclass,
                                                                      jstring liveId) {
  auto live = txt_get_live_entry(jstringToUtf8(env, liveId));
  if (!live) return nullptr;
  try {
    return utf8ToJstring(env, live->snapshotFullTextIfSpooled());
  } catch (...) {
    try {
      return utf8ToJstring(env, live->snapshotText());
    } catch (...) {
      return nullptr;
    }
  }
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeIsOffline(JNIEnv *env, jclass,
                                                                   jstring bufferId) {
  return txt_get_offline_entry(jstringToUtf8(env, bufferId)) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeIsLive(JNIEnv *env, jclass,
                                                                jstring bufferId) {
  return txt_get_live_entry(jstringToUtf8(env, bufferId)) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeOfflineUtf16Length(JNIEnv *env, jclass,
                                                                            jstring bufferId) {
  auto off = txt_get_offline_entry(jstringToUtf8(env, bufferId));
  return off ? off->utf16Length() : -1;
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeLiveState(JNIEnv *env, jclass,
                                                                   jstring liveId) {
  auto live = txt_get_live_entry(jstringToUtf8(env, liveId));
  if (!live) return -1;
  return live->state == TxtLiveEntry::FINISHED ? 1 : 0;
}

JNIEXPORT jlong JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeLiveTotalChars(JNIEnv *env, jclass,
                                                                        jstring liveId) {
  auto live = txt_get_live_entry(jstringToUtf8(env, liveId));
  return live ? (jlong)live->totalCharsWritten : -1;
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeLiveSegmentCount(JNIEnv *env, jclass,
                                                                          jstring liveId) {
  auto live = txt_get_live_entry(jstringToUtf8(env, liveId));
  return live ? live->segmentCount() : -1;
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeOfflinePopulated(JNIEnv *env, jclass,
                                                                          jstring bufferId) {
  auto off = txt_get_offline_entry(jstringToUtf8(env, bufferId));
  return off && off->populated ? JNI_TRUE : JNI_FALSE;
}

}  // extern "C"
