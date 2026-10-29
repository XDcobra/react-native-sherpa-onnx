#include "VideoFrameAccess.h"
#include "VideoImageBridge.h"
#include "VideoLog.h"
#include "VideoRegistry.h"
#include "decode/DecoderBackend.h"
#include "live/LiveIngest.h"
#include "live/LiveVideoEntry.h"
#include "platform/android/AMediaCodecDecoder.h"
#include "platform/android/AMediaCodecEncoder.h"

#include <jni.h>

#include <memory>
#include <string>
#include <vector>

#define TAG "SherpaOnnx:video"
#if defined(__ANDROID__)
#include <android/log.h>
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#else
#define LOGI(...) ((void)0)
#endif

using sherpa_onnx::video::ImageBridgeRequest;
using sherpa_onnx::video::LiveIngest;
using sherpa_onnx::video::LiveIngestOptions;
using sherpa_onnx::video::LiveVideoOptions;
using sherpa_onnx::video::MemoryPressureLevel;
using sherpa_onnx::video::SpoolRetentionMode;
using sherpa_onnx::video::VideoRegistry;
using sherpa_onnx::video::SetVideoLogEnabled;

namespace {

std::string JstringToStd(JNIEnv* env, jstring value) {
  if (!value) return {};
  const char* chars = env->GetStringUTFChars(value, nullptr);
  if (!chars) return {};
  std::string out(chars);
  env->ReleaseStringUTFChars(value, chars);
  return out;
}

jobject NewHashMap(JNIEnv* env, jmethodID* outPut) {
  jclass mapClass = env->FindClass("java/util/HashMap");
  jmethodID init = env->GetMethodID(mapClass, "<init>", "()V");
  jmethodID put = env->GetMethodID(
      mapClass, "put",
      "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
  jobject map = env->NewObject(mapClass, init);
  if (outPut) *outPut = put;
  env->DeleteLocalRef(mapClass);
  return map;
}

void PutString(JNIEnv* env, jobject map, jmethodID put, const char* k,
               const std::string& v) {
  jstring jk = env->NewStringUTF(k);
  jstring jv = env->NewStringUTF(v.c_str());
  env->CallObjectMethod(map, put, jk, jv);
  env->DeleteLocalRef(jk);
  env->DeleteLocalRef(jv);
}

void PutLong(JNIEnv* env, jobject map, jmethodID put, const char* k, int64_t v) {
  jclass lc = env->FindClass("java/lang/Long");
  jmethodID box = env->GetStaticMethodID(lc, "valueOf", "(J)Ljava/lang/Long;");
  jobject jv = env->CallStaticObjectMethod(lc, box, static_cast<jlong>(v));
  jstring jk = env->NewStringUTF(k);
  env->CallObjectMethod(map, put, jk, jv);
  env->DeleteLocalRef(jk);
  env->DeleteLocalRef(jv);
  env->DeleteLocalRef(lc);
}

jobject InfoToMap(JNIEnv* env, const sherpa_onnx::video::VideoBufferInfo& info) {
  jmethodID put = nullptr;
  jobject map = NewHashMap(env, &put);
  PutString(env, map, put, "bufferId", info.bufferId);
  PutString(env, map, put, "kind",
            info.kind == sherpa_onnx::video::VideoKind::Live
                ? "liveVideoBuffer"
                : "offlineVideoBuffer");
  const char* state = "immutable";
  if (info.state == sherpa_onnx::video::VideoBufferState::Recording) {
    state = "recording";
  } else if (info.state == sherpa_onnx::video::VideoBufferState::Finished) {
    state = "finished";
  }
  PutString(env, map, put, "state", state);
  PutLong(env, map, put, "frameCount", info.frameCount);
  PutLong(env, map, put, "liveEdgeUs", info.liveEdgeUs);
  PutLong(env, map, put, "totalFramesWritten", info.totalFramesWritten);
  PutLong(env, map, put, "ringEvictedFrames", info.ringEvictedFrames);
  PutString(env, map, put, "hasActiveSpool", info.hasActiveSpool ? "true" : "false");
  PutLong(env, map, put, "seekableStartUs", info.seekableRange.startUs);
  PutLong(env, map, put, "seekableEndUs", info.seekableRange.endUs);
  return map;
}

}  // namespace

extern "C" {

JNIEXPORT void JNICALL
Java_com_sherpaonnx_video_VideoBufferNative_nativeInit(JNIEnv* env, jclass,
                                                       jstring cacheDir,
                                                       jlong totalRam,
                                                       jboolean debug) {
  auto& reg = VideoRegistry::Instance();
  reg.SetCacheDir(JstringToStd(env, cacheDir));
  reg.ConfigureRam(static_cast<uint64_t>(totalRam));
  SetVideoLogEnabled(debug == JNI_TRUE);
  sherpa_onnx::video::RegisterDecoderFactory([]() {
    return std::unique_ptr<sherpa_onnx::video::DecoderBackend>(
        new sherpa_onnx::video::AMediaCodecDecoder());
  });
  const int n = reg.SweepOrphans();
  LOGI("VideoBuffer init orphanSweep=%d", n);
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_video_VideoBufferNative_nativeSetHwCodecs(
    JNIEnv* env, jclass, jstring h264Dec, jstring hevcDec, jstring h264Enc,
    jstring hevcEnc) {
  using sherpa_onnx::video::AMediaCodecDecoder;
  using sherpa_onnx::video::AMediaCodecEncoder;
  using sherpa_onnx::video::VideoCodec;
  AMediaCodecDecoder::SetGlobalHwDecoderName(VideoCodec::H264,
                                             JstringToStd(env, h264Dec));
  AMediaCodecDecoder::SetGlobalHwDecoderName(VideoCodec::Hevc,
                                             JstringToStd(env, hevcDec));
  AMediaCodecEncoder::SetGlobalHwEncoderName(VideoCodec::H264,
                                             JstringToStd(env, h264Enc));
  AMediaCodecEncoder::SetGlobalHwEncoderName(VideoCodec::Hevc,
                                             JstringToStd(env, hevcEnc));
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_video_VideoBufferNative_nativeOnTrimMemory(JNIEnv*, jclass,
                                                              jint level) {
  auto lv = level >= 80 ? MemoryPressureLevel::Critical
                        : MemoryPressureLevel::Moderate;
  VideoRegistry::Instance().OnMemoryPressure(lv);
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_video_VideoBufferNative_nativeCreateOfflineFromFile(
    JNIEnv* env, jclass, jstring jPath) {
  auto r = VideoRegistry::Instance().CreateOfflineFromFile(JstringToStd(env, jPath));
  jmethodID put = nullptr;
  jobject map = NewHashMap(env, &put);
  if (!r.ok()) {
    PutString(env, map, put, "errorCode", r.status.errorCode);
    PutString(env, map, put, "errorMessage", r.status.errorMessage);
    return map;
  }
  env->DeleteLocalRef(map);
  return InfoToMap(env, r.value->Info());
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_video_VideoBufferNative_nativeCreateLive(JNIEnv* env, jclass,
                                                            jint ringSeconds,
                                                            jint retentionMode,
                                                            jstring jPath) {
  LiveVideoOptions opts;
  opts.ringSeconds = ringSeconds > 0 ? ringSeconds : 10;
  switch (retentionMode) {
    case 1:
      opts.spool.mode = SpoolRetentionMode::None;
      break;
    case 2:
      opts.spool.mode = SpoolRetentionMode::MaxSeconds;
      break;
    case 3:
      opts.spool.mode = SpoolRetentionMode::Path;
      opts.spool.directory = JstringToStd(env, jPath);
      break;
    default:
      opts.spool.mode = SpoolRetentionMode::Session;
      break;
  }
  auto r = VideoRegistry::Instance().CreateLive(opts);
  return InfoToMap(env, r.value->Info());
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_video_VideoBufferNative_nativeGetInfo(JNIEnv* env, jclass,
                                                         jstring jId) {
  auto e = VideoRegistry::Instance().Get(JstringToStd(env, jId));
  if (!e) return nullptr;
  return InfoToMap(env, e->Info());
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_video_VideoBufferNative_nativeRelease(JNIEnv* env, jclass,
                                                         jstring jId) {
  return VideoRegistry::Instance().Release(JstringToStd(env, jId)) ? JNI_TRUE
                                                                  : JNI_FALSE;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_video_VideoBufferNative_nativeFinalizeLive(JNIEnv* env,
                                                              jclass,
                                                              jstring jId) {
  auto live = VideoRegistry::Instance().GetLive(JstringToStd(env, jId));
  jmethodID put = nullptr;
  jobject map = NewHashMap(env, &put);
  if (!live) {
    PutString(env, map, put, "errorCode", "VIDEO_BUFFER_NOT_FOUND");
    return map;
  }
  auto st = live->Finish();
  if (!st.ok) {
    PutString(env, map, put, "errorCode", st.errorCode);
    PutString(env, map, put, "errorMessage", st.errorMessage);
    return map;
  }
  env->DeleteLocalRef(map);
  return InfoToMap(env, live->Info());
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_video_VideoBufferNative_nativeIngestFile(JNIEnv* env, jclass,
                                                            jstring jId,
                                                            jstring jPath,
                                                            jboolean realtime) {
  auto live = VideoRegistry::Instance().GetLive(JstringToStd(env, jId));
  jmethodID put = nullptr;
  jobject map = NewHashMap(env, &put);
  if (!live) {
    PutString(env, map, put, "errorCode", "VIDEO_BUFFER_NOT_FOUND");
    return map;
  }
  LiveIngestOptions opts;
  opts.pacing = realtime ? sherpa_onnx::video::IngestPacing::Realtime
                         : sherpa_onnx::video::IngestPacing::AsFast;
  auto st = LiveIngest::Run(JstringToStd(env, jPath), live.get(), opts);
  if (!st.ok) {
    PutString(env, map, put, "errorCode", st.errorCode);
    PutString(env, map, put, "errorMessage", st.errorMessage);
    return map;
  }
  env->DeleteLocalRef(map);
  return InfoToMap(env, live->Info());
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_video_VideoBufferNative_nativeCreateImageFromVideo(
    JNIEnv* env, jclass, jstring jId, jint sampling, jint uniform, jdouble fps,
    jint maxSide, jlongArray jTimes) {
  ImageBridgeRequest req;
  req.sampling = static_cast<sherpa_onnx::video::SamplingMode>(sampling);
  req.uniformCount = uniform;
  req.fps = fps;
  req.maxSide = maxSide;
  if (jTimes) {
    const jsize n = env->GetArrayLength(jTimes);
    req.timesUs.resize(static_cast<size_t>(n));
    env->GetLongArrayRegion(jTimes, 0, n, reinterpret_cast<jlong*>(req.timesUs.data()));
  }
  auto r = sherpa_onnx::video::VideoImageBridge::CreateImageBuffer(
      JstringToStd(env, jId), req);
  jmethodID put = nullptr;
  jobject map = NewHashMap(env, &put);
  if (!r.status.ok) {
    PutString(env, map, put, "errorCode", r.status.errorCode);
    PutString(env, map, put, "errorMessage", r.status.errorMessage);
    return map;
  }
  PutString(env, map, put, "imageBufferId", r.imageBufferId);
  PutLong(env, map, put, "frameCount", r.frameCount);
  return map;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_video_VideoBufferNative_nativeKeyframeTimes(JNIEnv* env,
                                                               jclass,
                                                               jstring jId,
                                                               jlong fromUs,
                                                               jlong toUs,
                                                               jint maxCount) {
  auto e = VideoRegistry::Instance().Get(JstringToStd(env, jId));
  jclass al = env->FindClass("java/util/ArrayList");
  jmethodID init = env->GetMethodID(al, "<init>", "()V");
  jmethodID add = env->GetMethodID(al, "add", "(Ljava/lang/Object;)Z");
  jobject list = env->NewObject(al, init);
  if (!e || !e->timeline()) {
    env->DeleteLocalRef(al);
    return list;
  }
  auto times = e->timeline()->KeyframeTimes(fromUs, toUs,
                                            static_cast<size_t>(maxCount));
  jclass lc = env->FindClass("java/lang/Long");
  jmethodID box = env->GetStaticMethodID(lc, "valueOf", "(J)Ljava/lang/Long;");
  for (int64_t t : times) {
    jobject v = env->CallStaticObjectMethod(lc, box, static_cast<jlong>(t));
    env->CallBooleanMethod(list, add, v);
    env->DeleteLocalRef(v);
  }
  env->DeleteLocalRef(al);
  env->DeleteLocalRef(lc);
  return list;
}

}  // extern "C"
