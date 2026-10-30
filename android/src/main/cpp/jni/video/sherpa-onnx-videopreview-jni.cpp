#include "VideoLog.h"
#include "VideoRegistry.h"
#include "preview/PreviewPlayer.h"

#ifdef __ANDROID__
#include "platform/android/JniAudioTrackRenderer.h"
#include <android/native_window_jni.h>
#endif

#include <jni.h>

#include <memory>
#include <string>

using sherpa_onnx::video::VideoKind;
using sherpa_onnx::video::VideoRegistry;
using sherpa_onnx::video::preview::AudioDecision;
using sherpa_onnx::video::preview::PreviewInput;
using sherpa_onnx::video::preview::PreviewInputKind;
using sherpa_onnx::video::preview::PreviewPlayer;
using sherpa_onnx::video::preview::PreviewPlayerOptions;
using sherpa_onnx::video::preview::PreviewRegistry;
using sherpa_onnx::video::SeekMode;

#define TAG "SherpaOnnx:video.preview"
#if defined(__ANDROID__)
#include <android/log.h>
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#else
#define LOGI(...) ((void)0)
#endif

namespace {

JavaVM* gVm = nullptr;
jclass gVideoServiceClass = nullptr;
jmethodID gEmitMid = nullptr;

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

void EnsureSink(JNIEnv* env) {
  env->GetJavaVM(&gVm);
  if (gVideoServiceClass == nullptr) {
    jclass cls = env->FindClass("com/sherpaonnx/video/VideoBufferService");
    if (cls == nullptr) return;
    gVideoServiceClass = static_cast<jclass>(env->NewGlobalRef(cls));
    env->DeleteLocalRef(cls);
    gEmitMid = env->GetStaticMethodID(
        gVideoServiceClass, "emitNative",
        "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V");
  }
  PreviewRegistry::Instance().SetEventSink(
      [](const std::string& type, const std::string& playerId,
         const std::string& json) {
        if (gVm == nullptr || gVideoServiceClass == nullptr ||
            gEmitMid == nullptr) {
          return;
        }
        bool attached = false;
        JNIEnv* je = EnvOrAttach(&attached);
        if (je == nullptr) return;
        jstring jn = je->NewStringUTF("SherpaOnnxVideoPreviewEvent");
        jstring jt = je->NewStringUTF(type.c_str());
        jstring jb = je->NewStringUTF(playerId.c_str());
        jstring jp = je->NewStringUTF(json.c_str());
        je->CallStaticVoidMethod(gVideoServiceClass, gEmitMid, jn, jt, jb, jp);
        je->DeleteLocalRef(jn);
        je->DeleteLocalRef(jt);
        je->DeleteLocalRef(jb);
        je->DeleteLocalRef(jp);
        if (attached) gVm->DetachCurrentThread();
      });
}

SeekMode ParseMode(const std::string& m) {
  if (m == "keyframe") return SeekMode::Keyframe;
  if (m == "closestKeyframe") return SeekMode::ClosestKeyframe;
  return SeekMode::Accurate;
}

std::shared_ptr<PreviewPlayer> Player(JNIEnv* env, jstring jId) {
  return PreviewRegistry::Instance().Get(JstringToStd(env, jId));
}

jobject ErrorMap(JNIEnv* env, const char* code, const char* msg) {
  jmethodID put = nullptr;
  jobject map = NewHashMap(env, &put);
  PutString(env, map, put, "errorCode", code);
  PutString(env, map, put, "message", msg);
  return map;
}

AudioDecision DecideAudio(const sherpa_onnx::video::VideoBufferInfo& info,
                          bool off) {
  if (off) return AudioDecision::Off;
  if (!info.audio) return AudioDecision::Absent;
  if (!info.audio->decodable) return AudioDecision::Unsupported;
  return AudioDecision::Track;
}

}  // namespace

extern "C" {

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_video_preview_VideoPreviewNative_nativeCreate(
    JNIEnv* env, jclass, jstring jBufferId, jstring jOptionsJson) {
  EnsureSink(env);
  const std::string bufferId = JstringToStd(env, jBufferId);
  const std::string opt = JstringToStd(env, jOptionsJson);
  auto entry = VideoRegistry::Instance().Get(bufferId);
  if (!entry) {
    return ErrorMap(env, "VIDEO_BUFFER_NOT_FOUND", "buffer not found");
  }
  auto info = entry->Info();
  const bool audioOff = opt.find("\"source\":\"none\"") != std::string::npos;
  const bool required = opt.find("\"required\":true") != std::string::npos;
  PreviewPlayerOptions popts;
  popts.controller.isLive = info.kind == VideoKind::Live;
  popts.audioDecision = DecideAudio(info, audioOff);
  popts.controller.audioOff = audioOff;
  popts.controller.audioRequired = required;
  popts.controller.loop = opt.find("\"loop\":true") != std::string::npos;
  popts.controller.pauseOnBackground =
      opt.find("\"pauseOnBackground\":false") == std::string::npos;
  popts.muted = opt.find("\"muted\":true") != std::string::npos;
  if (info.audio) {
    popts.codecName = info.audio->codecName.empty()
                          ? sherpa_onnx::video::AudioCodecName(info.audio->codec)
                          : info.audio->codecName;
  }
  if (required && popts.audioDecision != AudioDecision::Track) {
    return ErrorMap(env, "VIDEO_PREVIEW_AUDIO_UNSUPPORTED",
                    "audio required but not playable");
  }
  auto player = PreviewRegistry::Instance().Create(entry, popts);
  PreviewInput prep;
  prep.kind = PreviewInputKind::Prepare;
  player->Post(prep, 0);
  PreviewInput prepared;
  prepared.kind = PreviewInputKind::Prepared;
  player->Post(prepared, 0);
  jmethodID put = nullptr;
  jobject map = NewHashMap(env, &put);
  PutString(env, map, put, "snapshotJson", player->SnapshotJson());
  PutString(env, map, put, "playerId", player->id());
  PutString(env, map, put, "bufferId", bufferId);
  PutString(env, map, put, "audioPlayable",
            popts.audioDecision == AudioDecision::Track ? "true" : "false");
  if (info.audio) {
    PutString(env, map, put, "audioSampleRate",
              std::to_string(info.audio->sampleRate));
    PutString(env, map, put, "audioChannels",
              std::to_string(info.audio->channels));
  }
  LOGI("video.preview create id=%s buf=%s audio=%d", player->id().c_str(),
       bufferId.c_str(), static_cast<int>(popts.audioDecision));
  return map;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_video_preview_VideoPreviewNative_nativeCommand(
    JNIEnv* env, jclass, jstring jId, jstring jCmd, jstring jArg) {
  auto p = Player(env, jId);
  if (!p) return ErrorMap(env, "VIDEO_PREVIEW_NOT_FOUND", "player not found");
  const std::string cmd = JstringToStd(env, jCmd);
  const std::string arg = JstringToStd(env, jArg);
  PreviewInput in;
  if (cmd == "play") {
    in.kind = PreviewInputKind::Play;
  } else if (cmd == "pause") {
    in.kind = PreviewInputKind::Pause;
  } else if (cmd == "seekToLiveEdge") {
    in.kind = PreviewInputKind::SeekLiveEdge;
  } else if (cmd == "stepFrame") {
    in.kind = PreviewInputKind::StepFrame;
    in.stepDir = arg == "-1" ? -1 : 1;
  } else if (cmd == "background") {
    in.kind = PreviewInputKind::AppBackground;
  } else if (cmd == "audioInterrupted") {
    PreviewRegistry::Instance().Emit(
        "audioInterrupted", p->id(),
        std::string("{\"reason\":\"") + (arg.empty() ? "focusLoss" : arg) +
            "\"}");
    in.kind = PreviewInputKind::Pause;
  } else {
    return ErrorMap(env, "VIDEO_PREVIEW_INVALID_ARGUMENT", "unknown command");
  }
  auto r = p->Post(in, p->state().positionUs);
  if (!r.status.ok) {
    return ErrorMap(env, r.status.errorCode.c_str(),
                    r.status.errorMessage.c_str());
  }
  jmethodID put = nullptr;
  jobject map = NewHashMap(env, &put);
  PutString(env, map, put, "ok", "true");
  PutString(env, map, put, "snapshotJson", p->SnapshotJson());
  return map;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_video_preview_VideoPreviewNative_nativeSeek(
    JNIEnv* env, jclass, jstring jId, jlong positionMs, jstring jMode,
    jboolean relative) {
  auto p = Player(env, jId);
  if (!p) return ErrorMap(env, "VIDEO_PREVIEW_NOT_FOUND", "player not found");
  PreviewInput in;
  in.kind = PreviewInputKind::Seek;
  in.mode = ParseMode(JstringToStd(env, jMode));
  int64_t tUs = static_cast<int64_t>(positionMs) * 1000;
  if (relative == JNI_TRUE) {
    tUs = p->state().positionUs + tUs;
  }
  in.tUs = tUs;
  auto r = p->Post(in, p->state().positionUs);
  if (!r.status.ok) {
    return ErrorMap(env, r.status.errorCode.c_str(),
                    r.status.errorMessage.c_str());
  }
  jmethodID put = nullptr;
  jobject map = NewHashMap(env, &put);
  PutString(env, map, put, "status", "completed");
  PutString(env, map, put, "requestedMs", std::to_string(positionMs));
  PutString(env, map, put, "actualMs",
            std::to_string(p->state().positionUs / 1000));
  return map;
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_video_preview_VideoPreviewNative_nativeSetVolume(
    JNIEnv* env, jclass, jstring jId, jfloat volume) {
  auto p = Player(env, jId);
  if (p) p->SetVolume(volume);
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_video_preview_VideoPreviewNative_nativeSetMuted(
    JNIEnv* env, jclass, jstring jId, jboolean muted) {
  auto p = Player(env, jId);
  if (p) p->SetMuted(muted == JNI_TRUE);
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_video_preview_VideoPreviewNative_nativeSetLoop(
    JNIEnv* env, jclass, jstring jId, jboolean loop) {
  auto p = Player(env, jId);
  if (p) p->SetLoop(loop == JNI_TRUE);
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_video_preview_VideoPreviewNative_nativeSnapshot(
    JNIEnv* env, jclass, jstring jId) {
  auto p = Player(env, jId);
  if (!p) return env->NewStringUTF("{\"errorCode\":\"VIDEO_PREVIEW_NOT_FOUND\"}");
  return env->NewStringUTF(p->SnapshotJson().c_str());
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_video_preview_VideoPreviewNative_nativeRelease(
    JNIEnv* env, jclass, jstring jId) {
  return PreviewRegistry::Instance().Release(JstringToStd(env, jId)) ? JNI_TRUE
                                                                     : JNI_FALSE;
}

#ifdef __ANDROID__
JNIEXPORT void JNICALL
Java_com_sherpaonnx_video_preview_VideoPreviewNative_nativeAttachSurface(
    JNIEnv* env, jclass, jstring jId, jobject surface, jdouble refreshHz) {
  auto p = Player(env, jId);
  if (!p || surface == nullptr) return;
  ANativeWindow* win = ANativeWindow_fromSurface(env, surface);
  if (win == nullptr) return;
  (void)p->AttachSurface(win, refreshHz);
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_video_preview_VideoPreviewNative_nativeDetachSurface(
    JNIEnv* env, jclass, jstring jId) {
  auto p = Player(env, jId);
  if (p) p->DetachSurface();
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_video_preview_VideoPreviewNative_nativeSetRefreshRate(
    JNIEnv* env, jclass, jstring jId, jdouble hz) {
  auto p = Player(env, jId);
  if (p) p->SetRefreshHz(hz);
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_video_preview_VideoPreviewNative_nativeBindAudioTrack(
    JNIEnv* env, jclass, jstring jId, jobject track) {
  auto p = Player(env, jId);
  if (!p || track == nullptr) return;
  auto r = std::make_unique<sherpa_onnx::video::preview::JniAudioTrackRenderer>();
  r->Bind(env, track);
  p->TakeAudioRenderer(std::move(r));
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_video_preview_VideoPreviewNative_nativeAppLifecycle(
    JNIEnv*, jclass, jboolean background) {
  if (background != JNI_TRUE) return;
  for (const auto& id : PreviewRegistry::Instance().Ids()) {
    auto p = PreviewRegistry::Instance().Get(id);
    if (!p) continue;
    PreviewInput in;
    in.kind = PreviewInputKind::AppBackground;
    p->Post(in, p->state().positionUs);
  }
}
#endif

}  // extern "C"
