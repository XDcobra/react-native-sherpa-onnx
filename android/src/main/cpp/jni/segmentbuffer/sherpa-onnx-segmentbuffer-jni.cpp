#include <jni.h>

#include "SegJson.h"
#include "SegmentLinkMapRegistry.h"
#include "SegmentRegistry.h"

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
Java_com_sherpaonnx_segment_pipeline_SegmentBufferNative_nativeInit(JNIEnv *env, jclass,
                                                                    jstring cacheDir) {
  seg_configure_cache_dir(jstringToUtf8(env, cacheDir));
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_segment_pipeline_SegmentBufferNative_nativeCreateEmptyOffline(
    JNIEnv *env, jclass, jstring sourceAudioBufferId) {
  std::string id, err;
  if (!seg_create_empty_offline(jstringToUtf8(env, sourceAudioBufferId), &id, &err)) return nullptr;
  return utf8ToJstring(env, id);
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_segment_pipeline_SegmentBufferNative_nativeCreateLive(
    JNIEnv *env, jclass, jstring sourceAudioBufferId, jint maxSegments, jstring spoolMode,
    jstring spoolPath, jboolean spoolTemporary, jlong spoolThresholdBytes,
    jboolean emitSegmentAppended, jlong segmentEventMinIntervalMs) {
  std::string id, err;
  if (!seg_create_live(jstringToUtf8(env, sourceAudioBufferId), maxSegments,
                       jstringToUtf8(env, spoolMode), jstringToUtf8(env, spoolPath),
                       spoolTemporary == JNI_TRUE, (int64_t)spoolThresholdBytes,
                       emitSegmentAppended == JNI_TRUE, (int64_t)segmentEventMinIntervalMs, &id,
                       &err)) {
    return nullptr;
  }
  return utf8ToJstring(env, id);
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_segment_pipeline_SegmentBufferNative_nativeAppendSegment(
    JNIEnv *env, jclass, jstring liveId, jstring kind, jstring sourceAudioBufferId, jint startSample,
    jint endSample, jint sampleRate, jint durationMs, jboolean hasConfidence, jdouble confidence,
    jstring payloadJson, jobjectArray outIds) {
  std::string segId;
  int segIndex = -1;
  std::string err;
  bool ok = seg_live_append_segment(
      jstringToUtf8(env, liveId), jstringToUtf8(env, kind), jstringToUtf8(env, sourceAudioBufferId),
      startSample, endSample, sampleRate, durationMs, hasConfidence == JNI_TRUE, confidence,
      jstringToUtf8(env, payloadJson), &segId, &segIndex, &err);
  if (ok && outIds && env->GetArrayLength(outIds) >= 2) {
    env->SetObjectArrayElement(outIds, 0, utf8ToJstring(env, segId));
    env->SetObjectArrayElement(outIds, 1, utf8ToJstring(env, std::to_string(segIndex)));
  }
  return ok ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_segment_pipeline_SegmentBufferNative_nativeFinalizeLive(JNIEnv *env, jclass,
                                                                            jstring liveId) {
  std::string err;
  return seg_finalize_live(jstringToUtf8(env, liveId), &err) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_segment_pipeline_SegmentBufferNative_nativeRelease(JNIEnv *env, jclass,
                                                                       jstring bufferId) {
  return seg_release_buffer(jstringToUtf8(env, bufferId)) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_segment_pipeline_SegmentBufferNative_nativeCreateOfflineFromLive(
    JNIEnv *env, jclass, jstring liveId, jstring mode) {
  std::string id, err;
  if (!seg_create_offline_from_live(jstringToUtf8(env, liveId), jstringToUtf8(env, mode), &id,
                                    &err)) {
    return nullptr;
  }
  return utf8ToJstring(env, id);
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_segment_pipeline_SegmentBufferNative_nativePopulateOfflineFromLive(
    JNIEnv *env, jclass, jstring offlineId, jstring liveId, jstring mode) {
  std::string err;
  return seg_populate_offline_from_live_if_empty(jstringToUtf8(env, offlineId),
                                                 jstringToUtf8(env, liveId),
                                                 jstringToUtf8(env, mode), &err)
             ? JNI_TRUE
             : JNI_FALSE;
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_segment_pipeline_SegmentBufferNative_nativeIsLive(JNIEnv *env, jclass,
                                                                      jstring bufferId) {
  return seg_get_live_entry(jstringToUtf8(env, bufferId)) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_segment_pipeline_SegmentBufferNative_nativeIsOffline(JNIEnv *env, jclass,
                                                                         jstring bufferId) {
  return seg_get_offline_entry(jstringToUtf8(env, bufferId)) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_segment_pipeline_SegmentBufferNative_nativeLiveSegmentCount(JNIEnv *env,
                                                                                jclass,
                                                                                jstring liveId) {
  auto live = seg_get_live_entry(jstringToUtf8(env, liveId));
  if (!live) return -1;
  std::lock_guard<std::mutex> lock(live->lock);
  return static_cast<jint>(live->segments.size());
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_segment_pipeline_SegmentBufferNative_nativeLiveSnapshotJson(
    JNIEnv *env, jclass, jstring liveId, jstring mode) {
  auto live = seg_get_live_entry(jstringToUtf8(env, liveId));
  if (!live) return nullptr;
  try {
    std::vector<SegRecord> records;
    const std::string m = jstringToUtf8(env, mode);
    if (m == "windowSnapshot") {
      records = live->snapshotWindow();
    } else {
      records = live->snapshotFullIfSpooled();
    }
    return utf8ToJstring(env, segment_records_to_json(records));
  } catch (...) {
    return nullptr;
  }
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_segment_pipeline_SegmentBufferNative_nativeOfflineSnapshotJson(
    JNIEnv *env, jclass, jstring offlineId) {
  auto off = seg_get_offline_entry(jstringToUtf8(env, offlineId));
  if (!off) return nullptr;
  return utf8ToJstring(env, segment_records_to_json(off->segments));
}

// --- Link map ---

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_segment_core_SegmentLinkMapNative_nativeCreate(JNIEnv *env, jclass,
                                                                   jstring textBufferId,
                                                                   jstring audioBufferId) {
  std::string id, err;
  if (!slm_create(jstringToUtf8(env, textBufferId), jstringToUtf8(env, audioBufferId), &id, &err)) {
    return nullptr;
  }
  return utf8ToJstring(env, id);
}

JNIEXPORT jstring JNICALL Java_com_sherpaonnx_segment_core_SegmentLinkMapNative_nativeAddLink(
    JNIEnv *env, jclass, jstring linkMapId, jstring textSegmentId, jstring speechSegmentId,
    jstring linkType, jboolean hasConfidence, jfloat confidence, jstring metaJson) {
  PaSegmentLink link;
  std::string err;
  if (!slm_add_link(jstringToUtf8(env, linkMapId), jstringToUtf8(env, textSegmentId),
                    jstringToUtf8(env, speechSegmentId), jstringToUtf8(env, linkType),
                    hasConfidence == JNI_TRUE, confidence, jstringToUtf8(env, metaJson), &link,
                    &err)) {
    return nullptr;
  }
  // Return linkId; Kotlin fills the rest from args.
  return utf8ToJstring(env, link.linkId);
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_segment_core_SegmentLinkMapNative_nativeRemoveLink(JNIEnv *env, jclass,
                                                                       jstring linkMapId,
                                                                       jstring linkId) {
  std::string err;
  return slm_remove_link(jstringToUtf8(env, linkMapId), jstringToUtf8(env, linkId), &err)
             ? JNI_TRUE
             : JNI_FALSE;
}

JNIEXPORT jint JNICALL Java_com_sherpaonnx_segment_core_SegmentLinkMapNative_nativeGetCount(
    JNIEnv *env, jclass, jstring linkMapId) {
  PaSegmentLinkMapInfo info;
  std::string err;
  if (!slm_get_info(jstringToUtf8(env, linkMapId), &info, &err)) return -1;
  return info.linkCount;
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_segment_core_SegmentLinkMapNative_nativeRelease(JNIEnv *env, jclass,
                                                                    jstring linkMapId) {
  return slm_release(jstringToUtf8(env, linkMapId)) ? JNI_TRUE : JNI_FALSE;
}

}  // extern "C"
