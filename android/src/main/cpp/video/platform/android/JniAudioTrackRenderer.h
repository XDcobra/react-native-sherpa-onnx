#pragma once

#ifdef __ANDROID__

#include "preview/Renderers.h"

#include <jni.h>

#include <atomic>
#include <cstdint>
#include <mutex>
#include <vector>

namespace sherpa_onnx {
namespace video {
namespace preview {

class JniAudioTrackRenderer : public IAudioRenderer {
 public:
  JniAudioTrackRenderer();
  ~JniAudioTrackRenderer() override;

  void Bind(JNIEnv* env, jobject track);
  Status Open(int sampleRate, int channels) override;
  void Start() override;
  void Pause() override;
  void Flush(uint64_t gen) override;
  void SetVolume(float v) override;
  int64_t queuedFrames() const override { return queued_.load(); }
  int Write(const float* data, int frames, int64_t ptsUs) override;
  void Close() override;
  bool Timestamp(int64_t* framePosition, int64_t* nanoTime) override;
  int64_t HeadPosition() override;
  int64_t FramesWritten() override { return written_.load(); }

 private:
  JNIEnv* Env();

  JavaVM* vm_ = nullptr;
  jobject track_ = nullptr;
  jobject directBuf_ = nullptr;
  float* directPtr_ = nullptr;
  int directCapBytes_ = 0;
  jmethodID open_ = nullptr;
  jmethodID write_ = nullptr;
  jmethodID play_ = nullptr;
  jmethodID pause_ = nullptr;
  jmethodID flush_ = nullptr;
  jmethodID timestamp_ = nullptr;
  jmethodID head_ = nullptr;
  jmethodID setVolume_ = nullptr;
  jmethodID release_ = nullptr;
  std::atomic<int64_t> written_{0};
  std::atomic<int64_t> queued_{0};
  int sampleRate_ = 0;
  int channels_ = 0;
  std::mutex mu_;
};

}  // namespace preview
}  // namespace video
}  // namespace sherpa_onnx

#endif
