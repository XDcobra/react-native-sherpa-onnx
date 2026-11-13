/**
 * jni_utf8.h
 *
 * Safe C++ UTF-8 -> Java String conversion for dynamic content (model output, file
 * names, error messages, JSON payloads).
 *
 * JNI's NewStringUTF expects *Modified* UTF-8 and aborts the process under CheckJNI
 * ("input is not valid Modified UTF-8") on malformed input. Model output is not
 * guaranteed to be valid UTF-8: byte-level BPE tokens can carry only part of a
 * multi-byte character (e.g. 0xE6 0xB5 without its third byte). Standard 4-byte
 * UTF-8 (emoji) is also not Modified UTF-8.
 *
 * NewJStringUtf8 decodes leniently to UTF-16 (invalid / truncated sequences become
 * U+FFFD, supplementary code points become surrogate pairs) and uses NewString.
 * Use it for every non-literal string handed to Java; literals/keys may keep
 * NewStringUTF.
 */
#pragma once

#include <jni.h>

#include <cstddef>
#include <cstring>
#include <string>

#include "jni/utf8_lenient.h"

namespace sherpaonnx {

/** Java String from (possibly malformed) UTF-8. Never trips CheckJNI. */
inline jstring NewJStringUtf8(JNIEnv* env, const char* data, size_t size) {
  const std::u16string utf16 =
      data != nullptr ? Utf8ToUtf16Lenient(data, size) : std::u16string();
  static const jchar kEmpty = 0;
  const jchar* chars = utf16.empty()
                           ? &kEmpty
                           : reinterpret_cast<const jchar*>(utf16.data());
  return env->NewString(chars, static_cast<jsize>(utf16.size()));
}

inline jstring NewJStringUtf8(JNIEnv* env, const std::string& s) {
  return NewJStringUtf8(env, s.data(), s.size());
}

inline jstring NewJStringUtf8(JNIEnv* env, const char* s) {
  return NewJStringUtf8(env, s, s != nullptr ? std::strlen(s) : 0);
}

}  // namespace sherpaonnx
