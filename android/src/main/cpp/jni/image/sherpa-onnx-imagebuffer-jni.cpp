#include "ImageFrameEncoder.h"
#include "ImageRegistry.h"
#include "decode/ImageDecoder.h"

#include <android/bitmap.h>
#include <android/log.h>
#include <jni.h>

#include <string>
#include <vector>

#define TAG "SherpaOnnx:image"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)

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
  if (!mapClass) return nullptr;
  jmethodID init = env->GetMethodID(mapClass, "<init>", "()V");
  jmethodID put = env->GetMethodID(
      mapClass, "put",
      "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
  if (!init || !put) {
    env->DeleteLocalRef(mapClass);
    return nullptr;
  }
  jobject map = env->NewObject(mapClass, init);
  env->DeleteLocalRef(mapClass);
  if (outPut) *outPut = put;
  return map;
}

void PutString(JNIEnv* env, jobject map, jmethodID put, const char* key,
               const std::string& value) {
  jstring jkey = env->NewStringUTF(key);
  jstring jval = env->NewStringUTF(value.c_str());
  env->CallObjectMethod(map, put, jkey, jval);
  env->DeleteLocalRef(jkey);
  env->DeleteLocalRef(jval);
}

void PutInt(JNIEnv* env, jobject map, jmethodID put, const char* key, jint value) {
  jclass intClass = env->FindClass("java/lang/Integer");
  jmethodID valueOf =
      env->GetStaticMethodID(intClass, "valueOf", "(I)Ljava/lang/Integer;");
  jobject boxed = env->CallStaticObjectMethod(intClass, valueOf, value);
  jstring jkey = env->NewStringUTF(key);
  env->CallObjectMethod(map, put, jkey, boxed);
  env->DeleteLocalRef(jkey);
  env->DeleteLocalRef(boxed);
  env->DeleteLocalRef(intClass);
}

void PutLong(JNIEnv* env, jobject map, jmethodID put, const char* key, jlong value) {
  jclass longClass = env->FindClass("java/lang/Long");
  jmethodID valueOf =
      env->GetStaticMethodID(longClass, "valueOf", "(J)Ljava/lang/Long;");
  jobject boxed = env->CallStaticObjectMethod(longClass, valueOf, value);
  jstring jkey = env->NewStringUTF(key);
  env->CallObjectMethod(map, put, jkey, boxed);
  env->DeleteLocalRef(jkey);
  env->DeleteLocalRef(boxed);
  env->DeleteLocalRef(longClass);
}

void PutBool(JNIEnv* env, jobject map, jmethodID put, const char* key, jboolean value) {
  jclass boolClass = env->FindClass("java/lang/Boolean");
  jmethodID valueOf =
      env->GetStaticMethodID(boolClass, "valueOf", "(Z)Ljava/lang/Boolean;");
  jobject boxed = env->CallStaticObjectMethod(boolClass, valueOf, value);
  jstring jkey = env->NewStringUTF(key);
  env->CallObjectMethod(map, put, jkey, boxed);
  env->DeleteLocalRef(jkey);
  env->DeleteLocalRef(boxed);
  env->DeleteLocalRef(boolClass);
}

jobject InfoToMap(JNIEnv* env, const sherpa_onnx::image::ImageBufferInfo& info) {
  jmethodID put = nullptr;
  jobject map = NewHashMap(env, &put);
  if (!map) return nullptr;
  PutString(env, map, put, "bufferId", info.bufferId);
  PutString(env, map, put, "kind", "offlineImageBuffer");
  PutString(env, map, put, "state",
            sherpa_onnx::image::BufferStateName(info.state));
  PutInt(env, map, put, "frameCount", info.frameCount);
  PutLong(env, map, put, "totalBytes", info.totalBytes);
  PutString(env, map, put, "storageKind",
            sherpa_onnx::image::StorageKindName(info.storageKind));
  return map;
}

}  // namespace

extern "C" {

JNIEXPORT void JNICALL
Java_com_sherpaonnx_image_ImageBufferNative_nativeInit(
    JNIEnv* env, jclass, jstring cacheDir, jlong totalRamBytes) {
  auto& reg = sherpa_onnx::image::ImageRegistry::Instance();
  reg.SetCacheDir(JstringToStd(env, cacheDir));
  reg.ConfigureThreshold(sherpa_onnx::image::ImageThresholdPlatform::Android,
                         static_cast<uint64_t>(totalRamBytes));
  const int n = reg.SweepOrphanedTempFiles();
  LOGI("ImageBuffer init cacheDir set, orphanSweep deleted=%d", n);
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_image_ImageBufferNative_nativeCreateEmpty(JNIEnv* env,
                                                              jclass) {
  const std::string id =
      sherpa_onnx::image::ImageRegistry::Instance().CreateEmpty();
  return env->NewStringUTF(id.c_str());
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_image_ImageBufferNative_nativeDecodeAndAppend(
    JNIEnv* env, jclass, jstring jBufferId, jbyteArray jBytes, jint maxSide,
    jboolean fileOrigin) {
  jmethodID put = nullptr;
  jobject map = NewHashMap(env, &put);
  if (!map) return nullptr;

  const std::string bufferId = JstringToStd(env, jBufferId);
  if (bufferId.empty() || !jBytes) {
    PutBool(env, map, put, "ok", JNI_FALSE);
    PutString(env, map, put, "errorCode", "ERR_IMAGE_INVALID_ARGUMENT");
    PutString(env, map, put, "errorMessage", "missing bufferId or bytes");
    return map;
  }

  const jsize len = env->GetArrayLength(jBytes);
  jbyte* bytes = env->GetByteArrayElements(jBytes, nullptr);
  if (!bytes) {
    PutBool(env, map, put, "ok", JNI_FALSE);
    PutString(env, map, put, "errorCode", "ERR_IMAGE_DECODE_FAILED");
    PutString(env, map, put, "errorMessage", "GetByteArrayElements failed");
    return map;
  }

  sherpa_onnx::image::DecodeOptions opts;
  opts.maxSide = maxSide;
  auto decoded = sherpa_onnx::image::ImageDecoder::DecodeBytes(
      reinterpret_cast<const uint8_t*>(bytes), static_cast<size_t>(len), opts);
  env->ReleaseByteArrayElements(jBytes, bytes, JNI_ABORT);

  if (!decoded.ok) {
    PutBool(env, map, put, "ok", JNI_FALSE);
    PutString(env, map, put, "errorCode", decoded.errorCode);
    PutString(env, map, put, "errorMessage", decoded.errorMessage);
    PutString(env, map, put, "format",
              sherpa_onnx::image::DecodeFormatName(decoded.format));
    return map;
  }

  const auto pathType =
      fileOrigin ? sherpa_onnx::image::ImageThresholdPathType::FileOrigin
                 : sherpa_onnx::image::ImageThresholdPathType::HeapOrigin;
  const bool appended =
      sherpa_onnx::image::ImageRegistry::Instance().AppendRgbFrame(
          bufferId, std::move(decoded.frame), pathType);
  if (!appended) {
    PutBool(env, map, put, "ok", JNI_FALSE);
    PutString(env, map, put, "errorCode", "ERR_IMAGE_INVALID_ARGUMENT");
    PutString(env, map, put, "errorMessage", "append failed (unknown bufferId?)");
    return map;
  }

  PutBool(env, map, put, "ok", JNI_TRUE);
  PutString(env, map, put, "format",
            sherpa_onnx::image::DecodeFormatName(decoded.format));
  PutInt(env, map, put, "orientationApplied", decoded.orientationApplied);
  return map;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_image_ImageBufferNative_nativeAppendRgb(
    JNIEnv* env, jclass, jstring jBufferId, jint width, jint height,
    jbyteArray jRgb, jboolean fileOrigin) {
  jmethodID put = nullptr;
  jobject map = NewHashMap(env, &put);
  if (!map) return nullptr;

  const std::string bufferId = JstringToStd(env, jBufferId);
  if (bufferId.empty() || !jRgb || width <= 0 || height <= 0) {
    PutBool(env, map, put, "ok", JNI_FALSE);
    PutString(env, map, put, "errorCode", "ERR_IMAGE_INVALID_ARGUMENT");
    PutString(env, map, put, "errorMessage", "invalid appendRgb args");
    return map;
  }

  const size_t need =
      static_cast<size_t>(width) * static_cast<size_t>(height) * 3u;
  const jsize len = env->GetArrayLength(jRgb);
  if (static_cast<size_t>(len) < need) {
    PutBool(env, map, put, "ok", JNI_FALSE);
    PutString(env, map, put, "errorCode", "ERR_IMAGE_INVALID_ARGUMENT");
    PutString(env, map, put, "errorMessage", "rgb byte array too short");
    return map;
  }

  jbyte* bytes = env->GetByteArrayElements(jRgb, nullptr);
  if (!bytes) {
    PutBool(env, map, put, "ok", JNI_FALSE);
    PutString(env, map, put, "errorCode", "ERR_IMAGE_DECODE_FAILED");
    PutString(env, map, put, "errorMessage", "GetByteArrayElements failed");
    return map;
  }

  sherpa_onnx::image::RgbFrame frame;
  frame.width = width;
  frame.height = height;
  frame.rgb.assign(reinterpret_cast<uint8_t*>(bytes),
                   reinterpret_cast<uint8_t*>(bytes) + need);
  env->ReleaseByteArrayElements(jRgb, bytes, JNI_ABORT);

  const auto pathType =
      fileOrigin ? sherpa_onnx::image::ImageThresholdPathType::FileOrigin
                 : sherpa_onnx::image::ImageThresholdPathType::HeapOrigin;
  const bool ok = sherpa_onnx::image::ImageRegistry::Instance().AppendRgbFrame(
      bufferId, std::move(frame), pathType);
  PutBool(env, map, put, "ok", ok ? JNI_TRUE : JNI_FALSE);
  if (!ok) {
    PutString(env, map, put, "errorCode", "ERR_IMAGE_INVALID_ARGUMENT");
    PutString(env, map, put, "errorMessage", "appendRgb failed");
  }
  return map;
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_image_ImageBufferNative_nativeMaybeUpgrade(
    JNIEnv* env, jclass, jstring jBufferId, jboolean fileOrigin) {
  const std::string bufferId = JstringToStd(env, jBufferId);
  const auto pathType =
      fileOrigin ? sherpa_onnx::image::ImageThresholdPathType::FileOrigin
                 : sherpa_onnx::image::ImageThresholdPathType::HeapOrigin;
  sherpa_onnx::image::ImageRegistry::Instance().MaybeUpgradeToMmap(bufferId,
                                                                   pathType);
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_image_ImageBufferNative_nativeGetInfo(JNIEnv* env, jclass,
                                                          jstring jBufferId) {
  sherpa_onnx::image::ImageBufferInfo info;
  if (!sherpa_onnx::image::ImageRegistry::Instance().GetInfo(
          JstringToStd(env, jBufferId), info)) {
    return nullptr;
  }
  return InfoToMap(env, info);
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_image_ImageBufferNative_nativeGetFrameInfo(
    JNIEnv* env, jclass, jstring jBufferId, jint frameIndex) {
  sherpa_onnx::image::ImageFrameInfo info;
  if (!sherpa_onnx::image::ImageRegistry::Instance().GetFrameInfo(
          JstringToStd(env, jBufferId), frameIndex, info)) {
    return nullptr;
  }
  jmethodID put = nullptr;
  jobject map = NewHashMap(env, &put);
  if (!map) return nullptr;
  PutInt(env, map, put, "index", info.index);
  PutInt(env, map, put, "width", info.width);
  PutInt(env, map, put, "height", info.height);
  PutLong(env, map, put, "byteSize", info.byteSize);
  PutString(env, map, put, "storageKind",
            sherpa_onnx::image::StorageKindName(info.storageKind));
  if (info.pageNumber > 0) {
    PutInt(env, map, put, "pageNumber", info.pageNumber);
  }
  if (info.dpi > 0) {
    PutInt(env, map, put, "dpi", info.dpi);
  }
  if (info.sectionIndex >= 0) {
    PutInt(env, map, put, "sectionIndex", info.sectionIndex);
  }
  if (!info.href.empty()) {
    PutString(env, map, put, "href", info.href);
  }
  if (!info.sourceVideoBufferId.empty()) {
    PutString(env, map, put, "sourceVideoBufferId", info.sourceVideoBufferId);
    PutLong(env, map, put, "sourcePtsUs", info.sourcePtsUs);
    PutLong(env, map, put, "sourceFrameIndex", info.sourceFrameIndex);
  }
  return map;
}

JNIEXPORT jboolean JNICALL
Java_com_sherpaonnx_image_ImageBufferNative_nativeRelease(JNIEnv* env, jclass,
                                                          jstring jBufferId) {
  return sherpa_onnx::image::ImageRegistry::Instance().Release(
             JstringToStd(env, jBufferId))
             ? JNI_TRUE
             : JNI_FALSE;
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_image_ImageBufferNative_nativeDetectFormat(
    JNIEnv* env, jclass, jbyteArray jBytes) {
  if (!jBytes) return env->NewStringUTF("unknown");
  const jsize len = env->GetArrayLength(jBytes);
  jbyte* bytes = env->GetByteArrayElements(jBytes, nullptr);
  if (!bytes) return env->NewStringUTF("unknown");
  const auto fmt = sherpa_onnx::image::ImageDecoder::DetectFormat(
      reinterpret_cast<const uint8_t*>(bytes), static_cast<size_t>(len));
  env->ReleaseByteArrayElements(jBytes, bytes, JNI_ABORT);
  return env->NewStringUTF(sherpa_onnx::image::DecodeFormatName(fmt));
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_image_ImageBufferNative_nativeExportFrame(
    JNIEnv* env, jclass, jstring jBufferId, jint frameIndex, jstring jOutPath,
    jstring jFormat, jint quality, jint maxSide) {
  jmethodID put = nullptr;
  jobject map = NewHashMap(env, &put);
  if (!map) return nullptr;

  const std::string bufferId = JstringToStd(env, jBufferId);
  const std::string outPath = JstringToStd(env, jOutPath);
  const std::string formatName = JstringToStd(env, jFormat);

  sherpa_onnx::image::ExportFormat format = sherpa_onnx::image::ExportFormat::Jpeg;
  if (!sherpa_onnx::image::ParseExportFormat(formatName, &format)) {
    PutBool(env, map, put, "ok", JNI_FALSE);
    PutString(env, map, put, "errorCode", "ERR_IMAGE_INVALID_ARGUMENT");
    PutString(env, map, put, "errorMessage", "unsupported export format");
    return map;
  }

  sherpa_onnx::image::ExportOptions opts;
  opts.format = format;
  opts.quality = quality;
  opts.maxSide = maxSide;

  const auto result = sherpa_onnx::image::ExportFrameToFile(
      bufferId, frameIndex, outPath, opts);
  PutBool(env, map, put, "ok", result.ok ? JNI_TRUE : JNI_FALSE);
  if (!result.ok) {
    PutString(env, map, put, "errorCode", result.errorCode);
    PutString(env, map, put, "errorMessage", result.errorMessage);
  }
  return map;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_image_ImageBufferNative_nativeEnsureFrame(
    JNIEnv* env, jclass, jstring jBufferId, jint frameIndex) {
  auto ensured = sherpa_onnx::image::ImageRegistry::Instance().EnsureFrame(
      JstringToStd(env, jBufferId), frameIndex);
  jmethodID put = nullptr;
  jobject map = NewHashMap(env, &put);
  if (!map) return nullptr;
  PutBool(env, map, put, "ok", ensured.ok ? JNI_TRUE : JNI_FALSE);
  if (!ensured.ok) {
    PutString(env, map, put, "errorCode", ensured.errorCode);
    PutString(env, map, put, "errorMessage", ensured.errorMessage);
    return map;
  }
  PutInt(env, map, put, "index", ensured.info.index);
  PutInt(env, map, put, "width", ensured.info.width);
  PutInt(env, map, put, "height", ensured.info.height);
  PutLong(env, map, put, "byteSize", ensured.info.byteSize);
  PutString(env, map, put, "storageKind",
            sherpa_onnx::image::StorageKindName(ensured.info.storageKind));
  if (ensured.info.pageNumber > 0) {
    PutInt(env, map, put, "pageNumber", ensured.info.pageNumber);
  }
  if (ensured.info.dpi > 0) {
    PutInt(env, map, put, "dpi", ensured.info.dpi);
  }
  if (ensured.info.sectionIndex >= 0) {
    PutInt(env, map, put, "sectionIndex", ensured.info.sectionIndex);
  }
  if (!ensured.info.href.empty()) {
    PutString(env, map, put, "href", ensured.info.href);
  }
  if (!ensured.info.sourceVideoBufferId.empty()) {
    PutString(env, map, put, "sourceVideoBufferId",
              ensured.info.sourceVideoBufferId);
    PutLong(env, map, put, "sourcePtsUs", ensured.info.sourcePtsUs);
    PutLong(env, map, put, "sourceFrameIndex", ensured.info.sourceFrameIndex);
  }
  return map;
}

JNIEXPORT jobject JNICALL
Java_com_sherpaonnx_image_ImageBufferNative_nativeCreateFrameBitmap(
    JNIEnv* env, jclass, jstring jBufferId, jint frameIndex, jint maxSide) {
  sherpa_onnx::image::RgbFrame scratch;
  const uint8_t* rgb = nullptr;
  int width = 0;
  int height = 0;
  if (!sherpa_onnx::image::ResolveFrameRgb(JstringToStd(env, jBufferId),
                                           frameIndex, maxSide, scratch, &rgb,
                                           &width, &height) ||
      !rgb || width <= 0 || height <= 0) {
    return nullptr;
  }

  jclass bitmapClass = env->FindClass("android/graphics/Bitmap");
  if (!bitmapClass) return nullptr;
  jclass configClass = env->FindClass("android/graphics/Bitmap$Config");
  if (!configClass) {
    env->DeleteLocalRef(bitmapClass);
    return nullptr;
  }
  jfieldID argbField = env->GetStaticFieldID(
      configClass, "ARGB_8888", "Landroid/graphics/Bitmap$Config;");
  jmethodID createBitmap = env->GetStaticMethodID(
      bitmapClass, "createBitmap",
      "(IILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;");
  if (!argbField || !createBitmap) {
    env->DeleteLocalRef(configClass);
    env->DeleteLocalRef(bitmapClass);
    return nullptr;
  }
  jobject config = env->GetStaticObjectField(configClass, argbField);
  env->DeleteLocalRef(configClass);
  if (!config) {
    env->DeleteLocalRef(bitmapClass);
    return nullptr;
  }

  jobject bitmap = env->CallStaticObjectMethod(bitmapClass, createBitmap, width,
                                               height, config);
  env->DeleteLocalRef(config);
  env->DeleteLocalRef(bitmapClass);
  if (!bitmap || env->ExceptionCheck()) {
    if (env->ExceptionCheck()) env->ExceptionClear();
    return nullptr;
  }

  AndroidBitmapInfo info;
  if (AndroidBitmap_getInfo(env, bitmap, &info) != ANDROID_BITMAP_RESULT_SUCCESS ||
      info.format != ANDROID_BITMAP_FORMAT_RGBA_8888 ||
      static_cast<int>(info.width) != width ||
      static_cast<int>(info.height) != height) {
    return nullptr;
  }

  void* pixels = nullptr;
  if (AndroidBitmap_lockPixels(env, bitmap, &pixels) !=
          ANDROID_BITMAP_RESULT_SUCCESS ||
      !pixels) {
    return nullptr;
  }

  // Android Bitmap ARGB_8888 is stored as RGBA byte order on little-endian
  // (R,G,B,A in memory). Fill row-by-row respecting stride.
  auto* dstBase = static_cast<uint8_t*>(pixels);
  for (int y = 0; y < height; ++y) {
    uint8_t* row = dstBase + static_cast<size_t>(y) * info.stride;
    const uint8_t* src =
        rgb + static_cast<size_t>(y) * static_cast<size_t>(width) * 3u;
    for (int x = 0; x < width; ++x) {
      row[x * 4 + 0] = src[x * 3 + 0];
      row[x * 4 + 1] = src[x * 3 + 1];
      row[x * 4 + 2] = src[x * 3 + 2];
      row[x * 4 + 3] = 255;
    }
  }
  AndroidBitmap_unlockPixels(env, bitmap);
  return bitmap;
}

}  // extern "C"
