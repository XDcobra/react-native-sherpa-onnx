#include <jni.h>

#include "TextRegistry.h"
#include "TxtSpatialSpanJson.h"
#include "TxtUtf16Codec.h"

#include <cstdio>
#include <sstream>
#include <string>
#include <vector>

namespace {

/** IDs / paths / modes — modified UTF-8 is fine (ASCII-heavy, no embedded NUL). */
std::string jstringToUtf8(JNIEnv *env, jstring s) {
  if (!s) return {};
  const char *chars = env->GetStringUTFChars(s, nullptr);
  std::string out = chars ? chars : "";
  if (chars) env->ReleaseStringUTFChars(s, chars);
  return out;
}

jstring utf8ToJstring(JNIEnv *env, const std::string &s) { return env->NewStringUTF(s.c_str()); }

/** Text content — UTF-16 jchar hop without modified UTF-8. */
std::string jstringToContentUtf8(JNIEnv *env, jstring s) {
  if (!s) return {};
  const jsize n = env->GetStringLength(s);
  if (n <= 0) return {};
  const jchar *chars = env->GetStringChars(s, nullptr);
  if (!chars) return {};
  std::string out = txt_utf8_from_utf16(reinterpret_cast<const uint16_t *>(chars), (size_t)n);
  env->ReleaseStringChars(s, chars);
  return out;
}

jstring contentUtf8ToJstring(JNIEnv *env, const std::string &s) {
  std::vector<uint16_t> units = txt_utf16_from_utf8(s);
  if (units.empty()) {
    return env->NewString(nullptr, 0);
  }
  return env->NewString(reinterpret_cast<const jchar *>(units.data()), (jsize)units.size());
}

void appendJsonEscaped(std::ostringstream &out, const std::string &s) {
  out << '"';
  for (unsigned char c : s) {
    switch (c) {
      case '"':
        out << "\\\"";
        break;
      case '\\':
        out << "\\\\";
        break;
      case '\b':
        out << "\\b";
        break;
      case '\f':
        out << "\\f";
        break;
      case '\n':
        out << "\\n";
        break;
      case '\r':
        out << "\\r";
        break;
      case '\t':
        out << "\\t";
        break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out << buf;
        } else {
          out << static_cast<char>(c);
        }
        break;
    }
  }
  out << '"';
}

std::string segmentsToJson(const std::vector<TextSegment> &segments) {
  std::ostringstream out;
  out << '[';
  for (size_t i = 0; i < segments.size(); ++i) {
    if (i > 0) out << ',';
    const TextSegment &seg = segments[i];
    out << '{';
    out << "\"text\":";
    appendJsonEscaped(out, seg.text);
    out << ",\"source\":";
    appendJsonEscaped(out, seg.source);
    out << ",\"segmentIndex\":" << seg.segmentIndex;
    out << ",\"metaJson\":";
    appendJsonEscaped(out, seg.metaJson);
    out << ",\"tokens\":[";
    for (size_t t = 0; t < seg.tokens.size(); ++t) {
      if (t > 0) out << ',';
      appendJsonEscaped(out, seg.tokens[t]);
    }
    out << "],\"timestamps\":[";
    for (size_t t = 0; t < seg.timestamps.size(); ++t) {
      if (t > 0) out << ',';
      out << seg.timestamps[t];
    }
    out << "]}";
  }
  out << ']';
  return out.str();
}

std::vector<std::string> jstringArrayToContentUtf8(JNIEnv *env, jobjectArray arr) {
  std::vector<std::string> out;
  if (!arr) return out;
  const jsize n = env->GetArrayLength(arr);
  out.reserve((size_t)n);
  for (jsize i = 0; i < n; ++i) {
    auto js = (jstring)env->GetObjectArrayElement(arr, i);
    out.push_back(jstringToContentUtf8(env, js));
    if (js) env->DeleteLocalRef(js);
  }
  return out;
}

std::vector<float> jfloatArrayToVector(JNIEnv *env, jfloatArray arr) {
  std::vector<float> out;
  if (!arr) return out;
  const jsize n = env->GetArrayLength(arr);
  out.resize((size_t)n);
  if (n > 0) {
    env->GetFloatArrayRegion(arr, 0, n, out.data());
  }
  return out;
}

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
  if (!txt_create_offline_from_text(jstringToContentUtf8(env, text), jstringToContentUtf8(env, lang),
                                    jstringToContentUtf8(env, emotion),
                                    jstringToContentUtf8(env, event), &id, &err)) {
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
  return txt_live_write_partial(live, jstringToContentUtf8(env, text), &err) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeAppendText(JNIEnv *env, jclass,
                                                                    jstring liveId, jstring text) {
  auto live = txt_get_live_entry(jstringToUtf8(env, liveId));
  std::string err;
  return txt_live_append_text(live, jstringToContentUtf8(env, text), &err) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeCommitSegment(
    JNIEnv *env, jclass, jstring liveId, jstring text, jobjectArray tokens, jfloatArray timestamps,
    jstring source, jstring metaJson) {
  auto live = txt_get_live_entry(jstringToUtf8(env, liveId));
  if (!live) return -1;
  try {
    return live->commitSegment(jstringToContentUtf8(env, text),
                               jstringArrayToContentUtf8(env, tokens),
                               jfloatArrayToVector(env, timestamps), jstringToUtf8(env, source),
                               jstringToContentUtf8(env, metaJson));
  } catch (...) {
    return -1;
  }
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeSnapshotText(JNIEnv *env, jclass,
                                                                      jstring liveId) {
  auto live = txt_get_live_entry(jstringToUtf8(env, liveId));
  std::string text, err;
  if (!txt_live_snapshot_text(live, &text, &err)) return nullptr;
  return contentUtf8ToJstring(env, text);
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeLiveRevision(JNIEnv *env, jclass,
                                                                      jstring liveId) {
  auto live = txt_get_live_entry(jstringToUtf8(env, liveId));
  return live ? live->revision.load() : -1;
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeCreateSegmentCursor(JNIEnv *env, jclass,
                                                                             jstring liveId) {
  auto live = txt_get_live_entry(jstringToUtf8(env, liveId));
  if (!live) return -1;
  return live->createSegmentCursor();
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeDrainSegments(JNIEnv *env, jclass,
                                                                       jstring liveId,
                                                                       jint cursorId,
                                                                       jint maxCount) {
  auto live = txt_get_live_entry(jstringToUtf8(env, liveId));
  if (!live) return nullptr;
  auto segs = live->drainSegments(cursorId, maxCount);
  return contentUtf8ToJstring(env, segmentsToJson(segs));
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeGetSegments(JNIEnv *env, jclass,
                                                                     jstring liveId,
                                                                     jint startIndex,
                                                                     jint maxCount) {
  auto live = txt_get_live_entry(jstringToUtf8(env, liveId));
  if (!live) return nullptr;
  auto segs = live->getSegments(startIndex, maxCount);
  return contentUtf8ToJstring(env, segmentsToJson(segs));
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeReleaseSegmentCursor(JNIEnv *env, jclass,
                                                                              jstring liveId,
                                                                              jint cursorId) {
  auto live = txt_get_live_entry(jstringToUtf8(env, liveId));
  if (!live) return JNI_FALSE;
  live->releaseSegmentCursor(cursorId);
  return JNI_TRUE;
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
  return contentUtf8ToJstring(env, text);
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeReadOfflineTextSlice(
    JNIEnv *env, jclass, jstring bufferId, jint startUtf16, jint maxUtf16) {
  std::string text, err;
  if (!txt_copy_offline_text_utf16_slice(jstringToUtf8(env, bufferId), startUtf16, maxUtf16, &text,
                                         &err)) {
    return nullptr;
  }
  return contentUtf8ToJstring(env, text);
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeSnapshotTextSlice(
    JNIEnv *env, jclass, jstring liveId, jint startUtf16, jint maxUtf16) {
  std::string text, err;
  if (!txt_copy_live_snapshot_utf16_slice(jstringToUtf8(env, liveId), startUtf16, maxUtf16, &text,
                                          &err)) {
    return nullptr;
  }
  return contentUtf8ToJstring(env, text);
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativePopulateIfEmpty(
    JNIEnv *env, jclass, jstring bufferId, jstring text, jobjectArray tokens,
    jfloatArray timestamps, jfloatArray durations, jstring lang, jstring emotion, jstring event,
    jstring spatialSpansJson) {
  std::vector<TxtSpatialSpan> spans;
  const std::string spansRaw = jstringToContentUtf8(env, spatialSpansJson);
  if (!spansRaw.empty() && !txt_span_json::decode(spansRaw, &spans)) {
    return JNI_FALSE;
  }
  std::string err;
  return txt_populate_offline_if_empty(
             jstringToUtf8(env, bufferId), jstringToContentUtf8(env, text),
             jstringArrayToContentUtf8(env, tokens), jfloatArrayToVector(env, timestamps),
             jfloatArrayToVector(env, durations), jstringToContentUtf8(env, lang),
             jstringToContentUtf8(env, emotion), jstringToContentUtf8(env, event), spans, &err)
             ? JNI_TRUE
             : JNI_FALSE;
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeOfflineTokensSlice(JNIEnv *env, jclass,
                                                                            jstring bufferId,
                                                                            jint start,
                                                                            jint maxCount) {
  auto off = txt_get_offline_entry(jstringToUtf8(env, bufferId));
  if (!off) return nullptr;
  return contentUtf8ToJstring(env, txt_span_json::encodeTokensSlice(off->tokens, start, maxCount));
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeOfflineTimestampsSlice(
    JNIEnv *env, jclass, jstring bufferId, jint start, jint maxCount) {
  auto off = txt_get_offline_entry(jstringToUtf8(env, bufferId));
  if (!off) return nullptr;
  return contentUtf8ToJstring(env, txt_span_json::encodeFloatSlice(off->timestamps, start, maxCount));
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeOfflineDurationsSlice(
    JNIEnv *env, jclass, jstring bufferId, jint start, jint maxCount) {
  auto off = txt_get_offline_entry(jstringToUtf8(env, bufferId));
  if (!off) return nullptr;
  return contentUtf8ToJstring(env, txt_span_json::encodeFloatSlice(off->durations, start, maxCount));
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeOfflineSpatialSpansSlice(
    JNIEnv *env, jclass, jstring bufferId, jint start, jint maxCount) {
  auto off = txt_get_offline_entry(jstringToUtf8(env, bufferId));
  if (!off) return nullptr;
  return contentUtf8ToJstring(env, txt_span_json::encodeSlice(off->spatialSpans, start, maxCount));
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeOfflineTokenCount(JNIEnv *env, jclass,
                                                                           jstring bufferId) {
  auto off = txt_get_offline_entry(jstringToUtf8(env, bufferId));
  return off ? off->tokenCount() : -1;
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeOfflineTimestampCount(JNIEnv *env, jclass,
                                                                               jstring bufferId) {
  auto off = txt_get_offline_entry(jstringToUtf8(env, bufferId));
  return off ? off->timestampCount() : -1;
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeOfflineDurationCount(JNIEnv *env, jclass,
                                                                              jstring bufferId) {
  auto off = txt_get_offline_entry(jstringToUtf8(env, bufferId));
  return off ? off->durationCount() : -1;
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeOfflineSpatialSpanCount(
    JNIEnv *env, jclass, jstring bufferId) {
  auto off = txt_get_offline_entry(jstringToUtf8(env, bufferId));
  return off ? off->spatialSpanCount() : -1;
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeOfflineLang(JNIEnv *env, jclass,
                                                                     jstring bufferId) {
  auto off = txt_get_offline_entry(jstringToUtf8(env, bufferId));
  if (!off) return nullptr;
  return contentUtf8ToJstring(env, off->lang);
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeOfflineEmotion(JNIEnv *env, jclass,
                                                                        jstring bufferId) {
  auto off = txt_get_offline_entry(jstringToUtf8(env, bufferId));
  if (!off) return nullptr;
  return contentUtf8ToJstring(env, off->emotion);
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_text_pipeline_TextBufferNative_nativeOfflineEvent(JNIEnv *env, jclass,
                                                                      jstring bufferId) {
  auto off = txt_get_offline_entry(jstringToUtf8(env, bufferId));
  if (!off) return nullptr;
  return contentUtf8ToJstring(env, off->event);
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
    return contentUtf8ToJstring(env, live->snapshotFullTextIfSpooled());
  } catch (...) {
    try {
      return contentUtf8ToJstring(env, live->snapshotText());
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
