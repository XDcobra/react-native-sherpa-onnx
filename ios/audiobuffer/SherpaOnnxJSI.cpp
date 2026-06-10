#include "SherpaOnnxJSI.h"

#include "../audio/pipeline/SherpaOnnx+PipelineAudioGlobals.h"
#include "AudioVisualization.h"

#include <cstring>
#include <string>
#include <vector>

using namespace facebook;

namespace {

std::string requireStringArg(jsi::Runtime &rt, const jsi::Value *args,
                             size_t index, const char *name) {
  if (!args[index].isString()) {
    throw jsi::JSError(rt,
                       std::string("[INVALID_ARGS] Expected string for ") + name);
  }
  return args[index].asString(rt).utf8(rt);
}

int requireIntArg(jsi::Runtime &rt, const jsi::Value *args, size_t index,
                  const char *name) {
  if (!args[index].isNumber()) {
    throw jsi::JSError(rt,
                       std::string("[INVALID_ARGS] Expected number for ") + name);
  }
  return static_cast<int>(args[index].asNumber());
}

jsi::ArrayBuffer requireArrayBufferArg(jsi::Runtime &rt, const jsi::Value *args,
                                       size_t index, const char *name) {
  if (!args[index].isObject()) {
    throw jsi::JSError(
        rt, std::string("[INVALID_ARGS] Expected ArrayBuffer for ") + name);
  }

  auto obj = args[index].asObject(rt);
  if (!obj.isArrayBuffer(rt)) {
    throw jsi::JSError(
        rt, std::string("[INVALID_ARGS] Expected ArrayBuffer for ") + name);
  }

  return obj.getArrayBuffer(rt);
}

std::vector<float> copyArrayBufferToFloatVector(jsi::Runtime &rt,
                                                 const jsi::ArrayBuffer &buffer) {
  const size_t byte_len = buffer.size(rt);
  if ((byte_len % sizeof(float)) != 0) {
    throw jsi::JSError(
        rt,
        "[INVALID_ARGS] ArrayBuffer byte length must be a multiple of 4 bytes");
  }

  const size_t sample_count = byte_len / sizeof(float);
  std::vector<float> out(sample_count);
  if (sample_count > 0) {
    std::memcpy(out.data(), buffer.data(rt), byte_len);
  }
  return out;
}

std::string joinError(const std::string &code, const std::string &message) {
  if (message.empty()) {
    return code;
  }
  if (code.empty()) {
    return message;
  }
  return code + " " + message;
}

jsi::Value jsiGetOfflineSamples(jsi::Runtime &rt, const jsi::Value &,
                                const jsi::Value *args, size_t count) {
  if (count < 3) {
    throw jsi::JSError(
        rt, "[INVALID_ARGS] getOfflineBufferSamples requires 3 arguments");
  }

  const std::string buffer_id = requireStringArg(rt, args, 0, "bufferId");
  const int start_frame = requireIntArg(rt, args, 1, "startFrame");
  const int frame_count = requireIntArg(rt, args, 2, "frameCount");

  std::vector<float> slice;
  std::string error_code;
  std::string error_message;
  const bool ok = pa_get_offline_samples_slice(buffer_id, start_frame, frame_count,
                                                &slice, &error_code, &error_message);
  if (!ok) {
    throw jsi::JSError(rt, joinError(error_code, error_message));
  }

  auto out = std::make_shared<sherpa::OwnedBuffer>(slice.size() * sizeof(float));
  if (!slice.empty()) {
    std::memcpy(out->data(), slice.data(), slice.size() * sizeof(float));
  }
  return jsi::ArrayBuffer(rt, std::move(out));
}

jsi::Value jsiGetLiveSamples(jsi::Runtime &rt, const jsi::Value &,
                             const jsi::Value *args, size_t count) {
  if (count < 3) {
    throw jsi::JSError(rt,
                       "[INVALID_ARGS] getLiveBufferSamples requires 3 arguments");
  }

  const std::string buffer_id = requireStringArg(rt, args, 0, "bufferId");
  const int start_frame = requireIntArg(rt, args, 1, "startFrame");
  const int frame_count = requireIntArg(rt, args, 2, "frameCount");

  std::vector<float> slice;
  std::string error_code;
  std::string error_message;
  const bool ok = pa_get_live_samples_slice(buffer_id, start_frame, frame_count,
                                             &slice, &error_code, &error_message);
  if (!ok) {
    throw jsi::JSError(rt, joinError(error_code, error_message));
  }

  auto out = std::make_shared<sherpa::OwnedBuffer>(slice.size() * sizeof(float));
  if (!slice.empty()) {
    std::memcpy(out->data(), slice.data(), slice.size() * sizeof(float));
  }
  return jsi::ArrayBuffer(rt, std::move(out));
}

jsi::Value jsiCreateOfflineFromSamples(jsi::Runtime &rt, const jsi::Value &,
                                       const jsi::Value *args, size_t count) {
  if (count < 3) {
    throw jsi::JSError(
        rt, "[INVALID_ARGS] createOfflineFromSamples requires 3 arguments");
  }

  const auto array_buffer =
      requireArrayBufferArg(rt, args, 0, "samples ArrayBuffer");
  const int sample_rate = requireIntArg(rt, args, 1, "sampleRate");
  const int channel_count = requireIntArg(rt, args, 2, "channelCount");

  auto samples = copyArrayBufferToFloatVector(rt, array_buffer);

  std::string json;
  std::string error_code;
  std::string error_message;
  const bool ok = pa_create_offline_from_samples(
      samples.data(), samples.size(), sample_rate, channel_count, &json,
      &error_code, &error_message);
  if (!ok) {
    throw jsi::JSError(rt, joinError(error_code, error_message));
  }

  return jsi::String::createFromUtf8(rt, json);
}

jsi::Value jsiAppendSamplesToLive(jsi::Runtime &rt, const jsi::Value &,
                                  const jsi::Value *args, size_t count) {
  if (count < 3) {
    throw jsi::JSError(rt,
                       "[INVALID_ARGS] appendSamplesToLive requires 3 arguments");
  }

  const std::string buffer_id = requireStringArg(rt, args, 0, "liveBufferId");
  const auto array_buffer =
      requireArrayBufferArg(rt, args, 1, "samples ArrayBuffer");
  const int sample_rate = requireIntArg(rt, args, 2, "sampleRate");

  auto samples = copyArrayBufferToFloatVector(rt, array_buffer);

  std::string error_code;
  std::string error_message;
  const bool ok = pa_append_samples_to_live(
      buffer_id, samples.data(), samples.size(), sample_rate, &error_code,
      &error_message);
  if (!ok) {
    throw jsi::JSError(rt, joinError(error_code, error_message));
  }

  return jsi::Value::undefined();
}

jsi::Value jsiTakeVisualizationFrames(jsi::Runtime &rt, const jsi::Value &,
                                      const jsi::Value *args, size_t count) {
  if (count < 1) {
    throw jsi::JSError(
        rt, "[INVALID_ARGS] takeVisualizationFrames requires 1 argument");
  }

  const std::string transfer_id = requireStringArg(rt, args, 0, "transferId");

  std::vector<float> frames;
  if (!sherpa::takeVisualizationFramesTransfer(transfer_id, &frames)) {
    throw jsi::JSError(
        rt,
        "[AUDIO_VISUALIZATION_TRANSFER_NOT_FOUND] Visualization frame transfer not found or already consumed");
  }

  auto out =
      std::make_shared<sherpa::OwnedBuffer>(frames.size() * sizeof(float));
  if (!frames.empty()) {
    std::memcpy(out->data(), frames.data(), frames.size() * sizeof(float));
  }
  return jsi::ArrayBuffer(rt, std::move(out));
}

}  // namespace

namespace sherpa {

void installJSIBindings(jsi::Runtime &rt) {
  auto obj = jsi::Object(rt);

  obj.setProperty(
      rt, "getOfflineBufferSamples",
      jsi::Function::createFromHostFunction(
          rt, jsi::PropNameID::forAscii(rt, "getOfflineBufferSamples"), 3,
          jsiGetOfflineSamples));

  obj.setProperty(
      rt, "createOfflineFromSamples",
      jsi::Function::createFromHostFunction(
          rt, jsi::PropNameID::forAscii(rt, "createOfflineFromSamples"), 3,
          jsiCreateOfflineFromSamples));

  obj.setProperty(
      rt, "getLiveBufferSamples",
      jsi::Function::createFromHostFunction(
          rt, jsi::PropNameID::forAscii(rt, "getLiveBufferSamples"), 3,
          jsiGetLiveSamples));

  obj.setProperty(
      rt, "appendSamplesToLive",
      jsi::Function::createFromHostFunction(
          rt, jsi::PropNameID::forAscii(rt, "appendSamplesToLive"), 3,
          jsiAppendSamplesToLive));

  obj.setProperty(
      rt, "takeVisualizationFrames",
      jsi::Function::createFromHostFunction(
          rt, jsi::PropNameID::forAscii(rt, "takeVisualizationFrames"), 1,
          jsiTakeVisualizationFrames));

  rt.global().setProperty(rt, "__SherpaOnnxJSI", std::move(obj));
}

}  // namespace sherpa
