#include <jni.h>

#include "AudioRegistry.h"

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

jstring utf8ToJstring(JNIEnv *env, const std::string &s) {
  return env->NewStringUTF(s.c_str());
}

jfloatArray vectorToJfloatArray(JNIEnv *env, const std::vector<float> &v) {
  jfloatArray arr = env->NewFloatArray((jsize)v.size());
  if (!arr) return nullptr;
  if (!v.empty()) {
    env->SetFloatArrayRegion(arr, 0, (jsize)v.size(), v.data());
  }
  return arr;
}

}  // namespace

extern "C" {

JNIEXPORT void JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeInit(JNIEnv *env, jclass,
                                                                jstring cacheDir,
                                                                jlong totalRamBytes) {
  pa_configure_cache_dir(jstringToUtf8(env, cacheDir));
  pa_configure_threshold((uint64_t)totalRamBytes);
  pa_sweepOrphanedTempFiles();
  pa_cleanupOrphanedOrchestrationFiles();
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeCreateOfflineFromSamples(
    JNIEnv *env, jclass, jfloatArray samples, jint sampleRate, jint channelCount) {
  if (!samples) return nullptr;
  jsize n = env->GetArrayLength(samples);
  std::vector<float> buf((size_t)n);
  if (n > 0) env->GetFloatArrayRegion(samples, 0, n, buf.data());
  std::string json, errCode, errMsg;
  if (!pa_create_offline_from_samples(buf.data(), buf.size(), sampleRate, channelCount, &json,
                                      &errCode, &errMsg)) {
    return nullptr;
  }
  // Return bufferId only — parse from json roughly
  auto pos = json.find("\"bufferId\":\"");
  if (pos == std::string::npos) return nullptr;
  pos += 12;
  auto end = json.find('"', pos);
  return utf8ToJstring(env, json.substr(pos, end - pos));
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeCreateEmptyOffline(
    JNIEnv *env, jclass, jint sampleRate, jint channelCount) {
  std::string id, errCode, errMsg;
  if (!pa_create_empty_offline(sampleRate, channelCount, &id, &errCode, &errMsg)) return nullptr;
  return utf8ToJstring(env, id);
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeCreateLive(
    JNIEnv *env, jclass, jint sampleRate, jint channelCount, jdouble windowSec, jstring spoolPath,
    jboolean emitEvents, jint minIntervalMs) {
  std::string id, errCode, errMsg;
  if (!pa_create_live(sampleRate, channelCount, windowSec, jstringToUtf8(env, spoolPath),
                      emitEvents == JNI_TRUE, minIntervalMs, &id, &errCode, &errMsg)) {
    return nullptr;
  }
  return utf8ToJstring(env, id);
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeAppendSamplesToLive(
    JNIEnv *env, jclass, jstring bufferId, jfloatArray samples, jint sampleRate) {
  // Bucket C #3 / D-A1: pin float[] like Int16 — no GetFloatArrayRegion + heap vector.
  if (!samples) return JNI_FALSE;
  const jsize n = env->GetArrayLength(samples);
  if (n <= 0) return JNI_FALSE;

  // Resolve id before critical — no other JNI calls while array is pinned.
  const std::string id = jstringToUtf8(env, bufferId);
  jfloat *elems = static_cast<jfloat *>(env->GetPrimitiveArrayCritical(samples, nullptr));
  if (!elems) return JNI_FALSE;
  std::string errCode, errMsg;
  const bool ok =
      pa_append_samples_to_live(id, elems, (size_t)n, sampleRate, &errCode, &errMsg);
  env->ReleasePrimitiveArrayCritical(samples, elems, JNI_ABORT);
  return ok ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeAppendInt16SamplesToLive(
    JNIEnv *env, jclass, jstring bufferId, jshortArray samples, jint sampleRate) {
  if (!samples) return JNI_FALSE;
  const jsize n = env->GetArrayLength(samples);
  if (n <= 0) return JNI_FALSE;

  // Resolve id before critical — no other JNI calls while array is pinned.
  const std::string id = jstringToUtf8(env, bufferId);
  jshort *elems = static_cast<jshort *>(env->GetPrimitiveArrayCritical(samples, nullptr));
  if (!elems) return JNI_FALSE;
  std::string errCode, errMsg;
  const bool ok =
      pa_append_int16_samples_to_live(id, reinterpret_cast<const int16_t *>(elems), (size_t)n,
                                      sampleRate, &errCode, &errMsg);
  env->ReleasePrimitiveArrayCritical(samples, elems, JNI_ABORT);
  return ok ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeFinalizeLive(JNIEnv *env, jclass,
                                                                        jstring bufferId) {
  std::string errCode, errMsg;
  return pa_finalize_live(jstringToUtf8(env, bufferId), &errCode, &errMsg) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeRelease(JNIEnv *env, jclass,
                                                                   jstring bufferId) {
  return pa_release_buffer(jstringToUtf8(env, bufferId)) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jfloatArray JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeReadAllOfflineSamples(JNIEnv *env,
                                                                                 jclass,
                                                                                 jstring bufferId) {
  std::vector<float> samples;
  int sr = 0;
  if (!pa_read_offline_samples(jstringToUtf8(env, bufferId), &samples, &sr)) return nullptr;
  return vectorToJfloatArray(env, samples);
}

JNIEXPORT jfloatArray JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeReadOfflineSlice(
    JNIEnv *env, jclass, jstring bufferId, jint start, jint count) {
  std::vector<float> out;
  std::string errCode, errMsg;
  if (!pa_get_offline_samples_slice(jstringToUtf8(env, bufferId), start, count, &out, &errCode,
                                    &errMsg)) {
    return nullptr;
  }
  return vectorToJfloatArray(env, out);
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeReadOfflineInto(
    JNIEnv *env, jclass, jstring bufferId, jint start, jfloatArray out, jint outOffset,
    jint maxSamples) {
  if (!out || maxSamples <= 0 || outOffset < 0 || start < 0) return 0;
  const jsize len = env->GetArrayLength(out);
  if (outOffset >= len) return 0;
  const int capacity = static_cast<int>(len - outOffset);
  const int toCopy = maxSamples < capacity ? maxSamples : capacity;
  if (toCopy <= 0) return 0;

  // Resolve id before critical — no other JNI calls while array is pinned.
  const std::string id = jstringToUtf8(env, bufferId);
  jfloat *elems = static_cast<jfloat *>(env->GetPrimitiveArrayCritical(out, nullptr));
  if (!elems) return 0;
  int copied = 0;
  std::string errCode, errMsg;
  const bool ok =
      pa_copy_offline_samples(id, start, elems + outOffset, toCopy, &copied, &errCode, &errMsg);
  env->ReleasePrimitiveArrayCritical(out, elems, ok ? 0 : JNI_ABORT);
  return ok ? copied : 0;
}

JNIEXPORT jfloatArray JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeReadLiveSlice(JNIEnv *env, jclass,
                                                                         jstring bufferId,
                                                                         jint start, jint count) {
  std::vector<float> out;
  std::string errCode, errMsg;
  if (!pa_get_live_samples_slice(jstringToUtf8(env, bufferId), start, count, &out, &errCode,
                                 &errMsg)) {
    return nullptr;
  }
  return vectorToJfloatArray(env, out);
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeOfflineNumSamples(JNIEnv *env, jclass,
                                                                             jstring bufferId) {
  int sr = 0, n = 0;
  std::string errCode, errMsg;
  if (!pa_get_offline_metadata(jstringToUtf8(env, bufferId), &sr, &n, &errCode, &errMsg)) return -1;
  return n;
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeOfflineSampleRate(JNIEnv *env, jclass,
                                                                             jstring bufferId) {
  int sr = 0, n = 0;
  std::string errCode, errMsg;
  if (!pa_get_offline_metadata(jstringToUtf8(env, bufferId), &sr, &n, &errCode, &errMsg)) return -1;
  return sr;
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeIsOffline(JNIEnv *env, jclass,
                                                                     jstring bufferId) {
  std::lock_guard<std::mutex> lock(g_pa_mutex);
  return g_pa_offline.count(jstringToUtf8(env, bufferId)) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeIsLive(JNIEnv *env, jclass,
                                                                  jstring bufferId) {
  std::lock_guard<std::mutex> lock(g_pa_mutex);
  return g_pa_live.count(jstringToUtf8(env, bufferId)) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeIsInvalidatedLive(JNIEnv *env, jclass,
                                                                             jstring bufferId) {
  return pa_is_live_invalidated(jstringToUtf8(env, bufferId)) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeCreateOfflineFromF32File(
    JNIEnv *env, jclass, jstring path, jint sampleRate, jint channelCount) {
  std::string id, errCode, errMsg;
  if (!pa_create_offline_from_f32_file(jstringToUtf8(env, path), sampleRate, channelCount, &id,
                                       &errCode, &errMsg)) {
    return nullptr;
  }
  return utf8ToJstring(env, id);
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeAdoptIfEmpty(JNIEnv *env, jclass,
                                                                        jstring bufferId,
                                                                        jfloatArray samples) {
  if (!samples) return JNI_FALSE;
  jsize n = env->GetArrayLength(samples);
  std::vector<float> buf((size_t)n);
  if (n > 0) env->GetFloatArrayRegion(samples, 0, n, buf.data());
  std::string errCode, errMsg;
  return pa_adopt_offline_samples_if_empty(jstringToUtf8(env, bufferId), std::move(buf), &errCode,
                                           &errMsg)
             ? JNI_TRUE
             : JNI_FALSE;
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativePopulateOfflineIfEmpty(
    JNIEnv *env, jclass, jstring targetBufferId, jstring sourceBufferId) {
  std::string errCode, errMsg;
  return pa_populate_offline_from_source_if_empty(jstringToUtf8(env, targetBufferId),
                                                  jstringToUtf8(env, sourceBufferId), &errCode,
                                                  &errMsg)
             ? JNI_TRUE
             : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeUpgradeToMmap(JNIEnv *env, jclass,
                                                                         jstring bufferId) {
  pa_upgradeToMmapIfNeeded(jstringToUtf8(env, bufferId));
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeTransferFromLive(
    JNIEnv *env, jclass, jstring liveBufferId, jboolean fullIfSpooled) {
  std::string offlineId, errCode, errMsg;
  if (!pa_transfer_offline_from_live(jstringToUtf8(env, liveBufferId), fullIfSpooled == JNI_TRUE,
                                     &offlineId, &errCode, &errMsg)) {
    return nullptr;
  }
  return utf8ToJstring(env, offlineId);
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeCloneOffline(JNIEnv *env, jclass,
                                                                        jstring sourceBufferId) {
  std::string offlineId, errCode, errMsg;
  if (!pa_clone_offline(jstringToUtf8(env, sourceBufferId), &offlineId, &errCode, &errMsg)) {
    return nullptr;
  }
  return utf8ToJstring(env, offlineId);
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeAppendOfflineToLive(
    JNIEnv *env, jclass, jstring liveBufferId, jstring offlineBufferId) {
  std::string errCode, errMsg;
  return pa_append_offline_to_live(jstringToUtf8(env, liveBufferId),
                                   jstringToUtf8(env, offlineBufferId), &errCode, &errMsg)
             ? JNI_TRUE
             : JNI_FALSE;
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeCreateCursor(JNIEnv *env, jclass,
                                                                        jstring liveBufferId) {
  auto live = pa_get_live_entry(jstringToUtf8(env, liveBufferId));
  if (!live) return -1;
  return live->createCursorHandle();
}

JNIEXPORT jfloatArray JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeDrainCursor(JNIEnv *env, jclass,
                                                                       jstring liveBufferId,
                                                                       jint cursorId,
                                                                       jint maxSamples) {
  auto live = pa_get_live_entry(jstringToUtf8(env, liveBufferId));
  if (!live) return nullptr;
  try {
    auto v = live->drainCursor(cursorId, maxSamples);
    return vectorToJfloatArray(env, v);
  } catch (...) {
    return nullptr;
  }
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeDrainCursorInto(
    JNIEnv *env, jclass, jstring liveBufferId, jint cursorId, jfloatArray out, jint outOffset,
    jint maxSamples) {
  if (!out || maxSamples <= 0 || outOffset < 0 || cursorId < 0) return 0;
  const jsize len = env->GetArrayLength(out);
  if (outOffset >= len) return 0;
  const int capacity = static_cast<int>(len - outOffset);
  const int toCopy = maxSamples < capacity ? maxSamples : capacity;
  if (toCopy <= 0) return 0;

  // Resolve id before critical — no other JNI calls while array is pinned.
  const std::string id = jstringToUtf8(env, liveBufferId);
  jfloat *elems = static_cast<jfloat *>(env->GetPrimitiveArrayCritical(out, nullptr));
  if (!elems) return 0;
  int copied = 0;
  std::string errCode, errMsg;
  const bool ok =
      pa_drain_cursor_into(id, cursorId, elems + outOffset, toCopy, &copied, &errCode, &errMsg);
  env->ReleasePrimitiveArrayCritical(out, elems, ok ? 0 : JNI_ABORT);
  return ok ? copied : 0;
}

JNIEXPORT jfloatArray JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativePeekCursor(JNIEnv *env, jclass,
                                                                      jstring liveBufferId,
                                                                      jint cursorId,
                                                                      jint maxSamples) {
  auto live = pa_get_live_entry(jstringToUtf8(env, liveBufferId));
  if (!live) return nullptr;
  try {
    auto v = live->peekCursor(cursorId, maxSamples);
    return vectorToJfloatArray(env, v);
  } catch (...) {
    return nullptr;
  }
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeReleaseCursor(JNIEnv *env, jclass,
                                                                         jstring liveBufferId,
                                                                         jint cursorId) {
  auto live = pa_get_live_entry(jstringToUtf8(env, liveBufferId));
  if (live) live->releaseCursor(cursorId);
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeLiveSampleRate(JNIEnv *env, jclass,
                                                                          jstring liveBufferId) {
  auto live = pa_get_live_entry(jstringToUtf8(env, liveBufferId));
  return live ? live->sampleRate : -1;
}

JNIEXPORT jlong JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeLiveTotalSamples(JNIEnv *env, jclass,
                                                                            jstring liveBufferId) {
  auto live = pa_get_live_entry(jstringToUtf8(env, liveBufferId));
  return live ? (jlong)live->totalSamplesWritten : -1;
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeLiveState(JNIEnv *env, jclass,
                                                                     jstring liveBufferId) {
  auto live = pa_get_live_entry(jstringToUtf8(env, liveBufferId));
  if (!live) return -1;
  return live->state == PaLiveEntry::FINISHED ? 1 : 0;
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeLiveHasActiveSpool(JNIEnv *env, jclass,
                                                                             jstring liveBufferId) {
  auto live = pa_get_live_entry(jstringToUtf8(env, liveBufferId));
  return live && live->hasActiveSpool ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeLiveSpoolPath(JNIEnv *env, jclass,
                                                                        jstring liveBufferId) {
  auto live = pa_get_live_entry(jstringToUtf8(env, liveBufferId));
  if (!live || live->spoolPath.empty()) return nullptr;
  return utf8ToJstring(env, live->spoolPath);
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeLiveActiveCursorCount(
    JNIEnv *env, jclass, jstring liveBufferId) {
  auto live = pa_get_live_entry(jstringToUtf8(env, liveBufferId));
  if (!live) return 0;
  return live->activeCursorCount();
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeSeekCursor(JNIEnv *env, jclass,
                                                                     jstring liveBufferId,
                                                                     jint cursorId,
                                                                     jlong absolutePos) {
  auto live = pa_get_live_entry(jstringToUtf8(env, liveBufferId));
  if (live) live->seekCursor(cursorId, (int64_t)absolutePos);
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeEnableSpool(JNIEnv *env, jclass,
                                                                      jstring liveBufferId,
                                                                      jstring path,
                                                                      jboolean temporary) {
  auto live = pa_get_live_entry(jstringToUtf8(env, liveBufferId));
  if (live) live->enableSpool(jstringToUtf8(env, path), temporary == JNI_TRUE);
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeOfflineStorageKind(JNIEnv *env, jclass,
                                                                              jstring bufferId) {
  std::shared_ptr<PaOfflineEntry> off;
  {
    std::lock_guard<std::mutex> lock(g_pa_mutex);
    auto it = g_pa_offline.find(jstringToUtf8(env, bufferId));
    if (it == g_pa_offline.end()) return nullptr;
    off = it->second;
  }
  return utf8ToJstring(env, off->storageKind());
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_audio_pipeline_AudioBufferNative_nativeOfflineFilePath(JNIEnv *env, jclass,
                                                                           jstring bufferId) {
  std::shared_ptr<PaOfflineEntry> off;
  {
    std::lock_guard<std::mutex> lock(g_pa_mutex);
    auto it = g_pa_offline.find(jstringToUtf8(env, bufferId));
    if (it == g_pa_offline.end()) return nullptr;
    off = it->second;
  }
  if (!off->mmapRegion || off->mmapRegion->filePath.empty()) return nullptr;
  return utf8ToJstring(env, off->mmapRegion->filePath);
}

}  // extern "C"
