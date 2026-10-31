#ifdef __ANDROID__

#include "platform/android/JniAudioTrackRenderer.h"

#include "VideoLog.h"

#include <algorithm>
#include <cstdlib>
#include <cstring>

namespace sherpa_onnx {
namespace video {
namespace preview {

JniAudioTrackRenderer::JniAudioTrackRenderer() = default;

JniAudioTrackRenderer::~JniAudioTrackRenderer() { Close(); }

JNIEnv* JniAudioTrackRenderer::Env() {
  if (vm_ == nullptr) return nullptr;
  JNIEnv* env = nullptr;
  if (vm_->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) == JNI_OK) {
    return env;
  }
  if (vm_->AttachCurrentThread(&env, nullptr) != 0) return nullptr;
  return env;
}

void JniAudioTrackRenderer::Bind(JNIEnv* env, jobject track) {
  std::lock_guard<std::mutex> lock(mu_);
  Close();
  if (env == nullptr || track == nullptr) return;
  env->GetJavaVM(&vm_);
  track_ = env->NewGlobalRef(track);
  jclass cls = env->GetObjectClass(track);
  open_ = env->GetMethodID(cls, "open", "()Z");
  write_ = env->GetMethodID(cls, "write", "(Ljava/nio/ByteBuffer;I)I");
  play_ = env->GetMethodID(cls, "play", "()V");
  pause_ = env->GetMethodID(cls, "pause", "()V");
  flush_ = env->GetMethodID(cls, "flush", "()V");
  timestamp_ = env->GetMethodID(cls, "timestamp", "([J)Z");
  head_ = env->GetMethodID(cls, "headPosition", "()J");
  setVolume_ = env->GetMethodID(cls, "setVolume", "(F)V");
  release_ = env->GetMethodID(cls, "release", "()V");
  env->DeleteLocalRef(cls);
}

Status JniAudioTrackRenderer::Open(int sampleRate, int channels) {
  std::lock_guard<std::mutex> lock(mu_);
  sampleRate_ = sampleRate;
  channels_ = channels;
  JNIEnv* env = Env();
  if (env == nullptr || track_ == nullptr || open_ == nullptr) {
    return Status::Fail(kErrPreviewAudioOutputFailed, "no track");
  }
  if (directBuf_ == nullptr) {
    directCapBytes_ = 8192 * static_cast<int>(sizeof(float));
    jobject local = env->NewDirectByteBuffer(
        malloc(static_cast<size_t>(directCapBytes_)), directCapBytes_);
    if (local == nullptr) {
      return Status::Fail(kErrPreviewAudioOutputFailed, "direct buffer");
    }
    directPtr_ = static_cast<float*>(env->GetDirectBufferAddress(local));
    directBuf_ = env->NewGlobalRef(local);
    env->DeleteLocalRef(local);
  }
  const jboolean ok = env->CallBooleanMethod(track_, open_);
  if (!ok) {
    if (onFailed) {
      onFailed(Status::Fail(kErrPreviewAudioOutputFailed, "AudioTrack.open"));
    }
    return Status::Fail(kErrPreviewAudioOutputFailed, "AudioTrack.open");
  }
  written_.store(0);
  queued_.store(0);
  VIDEO_LOGI("video.preview.audio track open sr=%d ch=%d", sampleRate, channels);
  return Status::Ok();
}

void JniAudioTrackRenderer::Start() {
  JNIEnv* env = Env();
  if (env && track_ && play_) env->CallVoidMethod(track_, play_);
}

void JniAudioTrackRenderer::Pause() {
  JNIEnv* env = Env();
  if (env && track_ && pause_) env->CallVoidMethod(track_, pause_);
}

void JniAudioTrackRenderer::Flush(uint64_t) {
  JNIEnv* env = Env();
  if (env && track_ && flush_) env->CallVoidMethod(track_, flush_);
  written_.store(0);
  queued_.store(0);
}

void JniAudioTrackRenderer::SetVolume(float v) {
  JNIEnv* env = Env();
  if (env && track_ && setVolume_) env->CallVoidMethod(track_, setVolume_, v);
}

int JniAudioTrackRenderer::Write(const float* data, int frames, int64_t) {
  JNIEnv* env = Env();
  if (env == nullptr || track_ == nullptr || write_ == nullptr ||
      directPtr_ == nullptr || frames <= 0) {
    return 0;
  }
  const int samples = frames * std::max(channels_, 1);
  const int bytes = samples * static_cast<int>(sizeof(float));
  if (bytes > directCapBytes_) {
    return 0;
  }
  std::memcpy(directPtr_, data, static_cast<size_t>(bytes));
  const jint n = env->CallIntMethod(track_, write_, directBuf_, bytes);
  if (n < 0) {
    if (onFailed) {
      onFailed(Status::Fail(kErrPreviewAudioOutputFailed, "AudioTrack.write"));
    }
    return n;
  }
  if (n == 0) {
    return 0;
  }
  const int ch = std::max(channels_, 1);
  const int got = n / (static_cast<int>(sizeof(float)) * ch);
  if (got <= 0) return 0;
  written_.fetch_add(got);
  queued_.store(got);
  return got;
}

bool JniAudioTrackRenderer::Timestamp(int64_t* framePosition, int64_t* nanoTime) {
  JNIEnv* env = Env();
  if (env == nullptr || track_ == nullptr || timestamp_ == nullptr) return false;
  jlongArray arr = env->NewLongArray(2);
  const jboolean ok = env->CallBooleanMethod(track_, timestamp_, arr);
  if (!ok) {
    env->DeleteLocalRef(arr);
    return false;
  }
  jlong vals[2] = {0, 0};
  env->GetLongArrayRegion(arr, 0, 2, vals);
  env->DeleteLocalRef(arr);
  if (framePosition) *framePosition = vals[0];
  if (nanoTime) *nanoTime = vals[1];
  return true;
}

int64_t JniAudioTrackRenderer::HeadPosition() {
  JNIEnv* env = Env();
  if (env == nullptr || track_ == nullptr || head_ == nullptr) return 0;
  return static_cast<int64_t>(env->CallLongMethod(track_, head_));
}

void JniAudioTrackRenderer::Close() {
  JNIEnv* env = Env();
  if (env && track_ && release_) {
    env->CallVoidMethod(track_, release_);
  }
  if (env && track_) env->DeleteGlobalRef(track_);
  track_ = nullptr;
  if (env && directBuf_) {
    void* addr = env->GetDirectBufferAddress(directBuf_);
    env->DeleteGlobalRef(directBuf_);
    if (addr) free(addr);
  }
  directBuf_ = nullptr;
  directPtr_ = nullptr;
}

}  // namespace preview
}  // namespace video
}  // namespace sherpa_onnx

#endif
