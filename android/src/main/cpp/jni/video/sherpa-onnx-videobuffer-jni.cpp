#include "VideoFrameAccess.h"
#include "VideoImageBridge.h"
#include "VideoLog.h"
#include "VideoRegistry.h"
#include "audio/LiveAudioTap.h"
#include "audio/VideoAudioExtractor.h"
#include "core/Uuid.h"
#include "decode/DecoderBackend.h"
#include "decode/DecoderPool.h"
#include "live/LiveIngest.h"
#include "live/LiveVideoEntry.h"
#include "demux/FfmpegProbe.h"
#include "encode/EncoderBackend.h"
#include "encode/VideoExportSession.h"
#include "platform/android/AMediaCodecDecoder.h"
#include "platform/android/AMediaCodecEncoder.h"

#include <jni.h>

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#define TAG "SherpaOnnx:video"
#if defined(__ANDROID__)
#include <android/log.h>
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#else
#define LOGI(...) ((void)0)
#endif

using sherpa_onnx::video::DecoderClass;
using sherpa_onnx::video::DecoderPool;
using sherpa_onnx::video::ImageBridgeRequest;
using sherpa_onnx::video::LiveIngest;
using sherpa_onnx::video::LiveIngestOptions;
using sherpa_onnx::video::LiveVideoOptions;
using sherpa_onnx::video::MemoryPressureLevel;
using sherpa_onnx::video::SpoolRetentionMode;
using sherpa_onnx::video::VideoRegistry;
using sherpa_onnx::video::SetVideoLogEnabled;

namespace {

JavaVM* gVm = nullptr;
jclass gVideoServiceClass = nullptr;
jmethodID gEmitMid = nullptr;

JNIEnv* EnvOrAttach(bool* attached) {
  *attached = false;
  if (gVm == nullptr) return nullptr;
  JNIEnv* env = nullptr;
  const jint got = gVm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6);
  if (got == JNI_OK) return env;
  if (got != JNI_EDETACHED) return nullptr;
#if defined(__ANDROID__)
  if (gVm->AttachCurrentThread(&env, nullptr) != 0) return nullptr;
#else
  if (gVm->AttachCurrentThread(reinterpret_cast<void**>(&env), nullptr) != 0) {
    return nullptr;
  }
#endif
  *attached = true;
  return env;
}

void EmitVideoEvent(const std::string& eventName, const std::string& type,
                    const std::string& bufferId, const std::string& json) {
  if (gVm == nullptr || gVideoServiceClass == nullptr || gEmitMid == nullptr) {
    return;
  }
  bool attached = false;
  JNIEnv* env = EnvOrAttach(&attached);
  if (env == nullptr) return;
  jstring jn = env->NewStringUTF(eventName.c_str());
  jstring jt = env->NewStringUTF(type.c_str());
  jstring jb = env->NewStringUTF(bufferId.c_str());
  jstring jp = env->NewStringUTF(json.c_str());
  env->CallStaticVoidMethod(gVideoServiceClass, gEmitMid, jn, jt, jb, jp);
  env->DeleteLocalRef(jn);
  env->DeleteLocalRef(jt);
  env->DeleteLocalRef(jb);
  env->DeleteLocalRef(jp);
  if (attached) {
    gVm->DetachCurrentThread();
  }
}

void InstallAndroidEventSink(JNIEnv* env) {
  env->GetJavaVM(&gVm);
  if (gVideoServiceClass == nullptr) {
    jclass cls = env->FindClass("com/sherpaonnx/video/VideoBufferService");
    if (cls == nullptr) {
      VIDEO_LOGE("video.event VideoBufferService class not found");
      return;
    }
    gVideoServiceClass = static_cast<jclass>(env->NewGlobalRef(cls));
    env->DeleteLocalRef(cls);
    gEmitMid = env->GetStaticMethodID(
        gVideoServiceClass, "emitNative",
        "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V");
    if (gEmitMid == nullptr) {
      VIDEO_LOGE("video.event emitNative method not found");
      return;
    }
  }
  VideoRegistry::Instance().SetEventSink(
      [](const std::string& type, const std::string& bufferId,
         const std::string& json) {
        EmitVideoEvent("SherpaOnnxVideoEvent", type, bufferId, json);
      });
  LOGI("VideoBuffer Android event sink installed");
}

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
  if (info.audio) {
    PutString(env, map, put, "audioCodec",
              info.audio->codecName.empty()
                  ? sherpa_onnx::video::AudioCodecName(info.audio->codec)
                  : info.audio->codecName);
    PutString(env, map, put, "audioDecodable",
              info.audio->decodable ? "true" : "false");
    PutLong(env, map, put, "audioSampleRate", info.audio->sampleRate);
    PutLong(env, map, put, "audioChannels", info.audio->channels);
    PutLong(env, map, put, "audioStartUs", info.audioRange.startUs);
    PutLong(env, map, put, "audioDurationUs",
            info.audioRange.endUs > info.audioRange.startUs
                ? info.audioRange.endUs - info.audioRange.startUs
                : 0);
  }
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
  sherpa_onnx::video::RegisterEncoderFactory([]() {
    return std::unique_ptr<sherpa_onnx::video::EncoderBackend>(
        new sherpa_onnx::video::AMediaCodecEncoder());
  });
  InstallAndroidEventSink(env);
  const int n = reg.SweepOrphans();
  LOGI("VideoBuffer init orphanSweep=%d", n);
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_video_VideoBufferNative_nativeConfigureDecoderBudget(
    JNIEnv*, jclass, jint cpu, jint display) {
  if (cpu > 0) {
    DecoderPool::Instance().SetMaxSessions(DecoderClass::Cpu,
                                           static_cast<int>(cpu));
  }
  if (display > 0) {
    DecoderPool::Instance().SetMaxSessions(DecoderClass::Display,
                                           static_cast<int>(display));
  }
  LOGI("VideoBuffer decoderBudget cpu=%d display=%d",
       DecoderPool::Instance().maxSessions(DecoderClass::Cpu),
       DecoderPool::Instance().maxSessions(DecoderClass::Display));
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
                                                            jboolean realtime,
                                                            jboolean includeAudio) {
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
  opts.includeAudio = includeAudio == JNI_TRUE;
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

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_video_VideoBufferNative_nativeExtractAudioFromVideo(
    JNIEnv* env, jclass, jstring jId, jlong startUs, jlong endUs,
    jint targetRate, jstring jOutPath, jlong cancelAddr, jobject progress) {
  using sherpa_onnx::video::AudioExtractOptions;
  using sherpa_onnx::video::AudioExtractResult;
  using sherpa_onnx::video::UuidV4;
  using sherpa_onnx::video::VideoAudioExtractor;
  jmethodID put = nullptr;
  jobject map = NewHashMap(env, &put);
  auto e = VideoRegistry::Instance().Get(JstringToStd(env, jId));
  if (!e) {
    PutString(env, map, put, "errorCode", "VIDEO_BUFFER_NOT_FOUND");
    PutString(env, map, put, "errorMessage", "extract");
    return map;
  }
  AudioExtractOptions opts;
  opts.rangeStartUs = startUs;
  opts.rangeEndUs = endUs;
  opts.targetSampleRate = targetRate;
  std::string outPath = JstringToStd(env, jOutPath);
  if (outPath.empty()) {
    const std::string dir = VideoRegistry::Instance().cacheDir();
    outPath = (dir.empty() ? std::string("/tmp") : dir) + "/vid_aud_" +
              UuidV4() + ".f32";
  }
  std::atomic<bool>* cancel =
      cancelAddr != 0 ? reinterpret_cast<std::atomic<bool>*>(cancelAddr)
                      : nullptr;
  jmethodID progressMid = nullptr;
  jobject progressGlobal = nullptr;
  if (progress) {
    progressGlobal = env->NewGlobalRef(progress);
    jclass cls = env->GetObjectClass(progress);
    progressMid = env->GetMethodID(cls, "onProgress", "(IJ)V");
    env->DeleteLocalRef(cls);
  }
  AudioExtractResult result;
  auto st = VideoAudioExtractor::Run(
      e, opts, outPath, cancel,
      [&](int percent, int64_t decodedMs) {
        if (progressGlobal == nullptr || progressMid == nullptr) {
          return;
        }
        env->CallVoidMethod(progressGlobal, progressMid, percent,
                            static_cast<jlong>(decodedMs));
      },
      &result);
  if (progressGlobal) {
    env->DeleteGlobalRef(progressGlobal);
  }
  if (!st.ok) {
    PutString(env, map, put, "errorCode", st.errorCode);
    PutString(env, map, put, "errorMessage", st.errorMessage);
    return map;
  }
  PutString(env, map, put, "path", result.path);
  PutLong(env, map, put, "numSamples", result.numSamples);
  PutLong(env, map, put, "sampleRate", result.sampleRate);
  PutLong(env, map, put, "mediaStartUs", result.mediaStartUs);
  PutString(env, map, put, "sourceCodec", result.sourceCodec);
  PutLong(env, map, put, "sourceSampleRate", result.sourceSampleRate);
  PutLong(env, map, put, "sourceChannels", result.sourceChannels);
  return map;
}

namespace {
std::mutex gTapMu;
std::unordered_map<std::string, std::unique_ptr<sherpa_onnx::video::LiveAudioTap>>
    gTaps;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_video_VideoBufferNative_nativeStartLiveAudioTap(
    JNIEnv* env, jclass, jstring jVideoId, jstring jAudioId, jint targetRate) {
  jmethodID put = nullptr;
  jobject map = NewHashMap(env, &put);
  const std::string videoId = JstringToStd(env, jVideoId);
  const std::string audioId = JstringToStd(env, jAudioId);
  auto entry = VideoRegistry::Instance().Get(videoId);
  if (!entry) {
    PutString(env, map, put, "errorCode", "VIDEO_BUFFER_NOT_FOUND");
    return map;
  }
  env->GetJavaVM(&gVm);
  jclass regCls = env->FindClass(
      "com/sherpaonnx/audio/pipeline/PipelineAudioRegistry");
  if (regCls == nullptr) {
    PutString(env, map, put, "errorCode", "VIDEO_INTERNAL");
    return map;
  }
  jmethodID appendMid = env->GetStaticMethodID(
      regCls, "appendSamplesToLiveJni", "(Ljava/lang/String;[FI)V");
  jclass gReg = static_cast<jclass>(env->NewGlobalRef(regCls));
  env->DeleteLocalRef(regCls);
  auto tap = std::make_unique<sherpa_onnx::video::LiveAudioTap>();
  auto st = tap->Start(
      entry, targetRate,
      [gReg, appendMid, audioId](const float* samples, int n, int sr) {
        if (gVm == nullptr || samples == nullptr || n <= 0) return;
        bool attached = false;
        JNIEnv* je = EnvOrAttach(&attached);
        if (je == nullptr) return;
        jfloatArray arr = je->NewFloatArray(n);
        je->SetFloatArrayRegion(arr, 0, n, samples);
        jstring jid = je->NewStringUTF(audioId.c_str());
        je->CallStaticVoidMethod(gReg, appendMid, jid, arr, sr);
        je->DeleteLocalRef(arr);
        je->DeleteLocalRef(jid);
        if (attached) gVm->DetachCurrentThread();
      });
  if (!st.ok) {
    PutString(env, map, put, "errorCode", st.errorCode);
    PutString(env, map, put, "errorMessage", st.errorMessage);
    return map;
  }
  {
    std::lock_guard<std::mutex> lock(gTapMu);
    auto it = gTaps.find(videoId);
    if (it != gTaps.end()) it->second->Stop();
    gTaps[videoId] = std::move(tap);
  }
  PutString(env, map, put, "ok", "true");
  return map;
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_video_VideoBufferNative_nativeStopLiveAudioTap(
    JNIEnv* env, jclass, jstring jVideoId) {
  const std::string videoId = JstringToStd(env, jVideoId);
  std::unique_ptr<sherpa_onnx::video::LiveAudioTap> tap;
  {
    std::lock_guard<std::mutex> lock(gTapMu);
    auto it = gTaps.find(videoId);
    if (it == gTaps.end()) return JNI_FALSE;
    tap = std::move(it->second);
    gTaps.erase(it);
  }
  if (tap) tap->Stop();
  return JNI_TRUE;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_video_VideoBufferNative_nativeExportVideo(
    JNIEnv* env, jclass, jstring jId, jstring jOutPath, jstring jFormat,
    jstring jCodec, jint bitrate, jlong fromUs, jlong toUs, jint maxSide,
    jlong cancelAddr, jobject progress) {
  using sherpa_onnx::video::VideoCodec;
  using sherpa_onnx::video::VideoExportOptions;
  using sherpa_onnx::video::VideoExportSession;
  jmethodID put = nullptr;
  jobject map = NewHashMap(env, &put);
  VideoExportOptions opts;
  const std::string codec = JstringToStd(env, jCodec);
  opts.codec = codec == "hevc" ? VideoCodec::Hevc : VideoCodec::H264;
  opts.bitrate = bitrate;
  opts.fromUs = fromUs;
  opts.toUs = toUs;
  opts.maxSide = maxSide;
  std::atomic<bool>* cancel =
      cancelAddr != 0 ? reinterpret_cast<std::atomic<bool>*>(cancelAddr)
                      : nullptr;
  jmethodID progressMid = nullptr;
  jobject progressGlobal = nullptr;
  if (progress) {
    progressGlobal = env->NewGlobalRef(progress);
    jclass cls = env->GetObjectClass(progress);
    progressMid = env->GetMethodID(cls, "onProgress", "(IJ)V");
    env->DeleteLocalRef(cls);
  }
  auto st = VideoExportSession::Run(
      JstringToStd(env, jId), JstringToStd(env, jOutPath),
      JstringToStd(env, jFormat), opts, cancel,
      [&](int percent, int64_t encodedUs) {
        if (progressGlobal == nullptr || progressMid == nullptr) {
          return;
        }
        env->CallVoidMethod(progressGlobal, progressMid, percent,
                            static_cast<jlong>(encodedUs));
      });
  if (progressGlobal) {
    env->DeleteGlobalRef(progressGlobal);
  }
  if (!st.ok) {
    PutString(env, map, put, "errorCode", st.errorCode);
    PutString(env, map, put, "errorMessage", st.errorMessage);
    return map;
  }
  PutString(env, map, put, "ok", "true");
  return map;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_video_VideoBufferNative_nativeProbeVideoFile(
    JNIEnv* env, jclass, jstring jPath) {
  using sherpa_onnx::video::ProbeVideoFile;
  using sherpa_onnx::video::VideoFileProbe;
  jmethodID put = nullptr;
  jobject map = NewHashMap(env, &put);
  VideoFileProbe probe;
  auto st = ProbeVideoFile(JstringToStd(env, jPath), &probe);
  if (!st.ok) {
    PutString(env, map, put, "errorCode", st.errorCode);
    PutString(env, map, put, "errorMessage", st.errorMessage);
    return map;
  }
  PutString(env, map, put, "inputFormatName", probe.inputFormatName);
  PutString(env, map, put, "codecName", probe.codecName);
  PutLong(env, map, put, "codedWidth", probe.codedWidth);
  PutLong(env, map, put, "codedHeight", probe.codedHeight);
  PutLong(env, map, put, "durationUs", probe.durationUs);
  PutLong(env, map, put, "isExact", probe.durationExact ? 1 : 0);
  if (probe.audioCodecName && !probe.audioCodecName->empty()) {
    PutString(env, map, put, "audioCodecName", *probe.audioCodecName);
  }
  return map;
}

}  // extern "C"
