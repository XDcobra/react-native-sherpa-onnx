// JNI for the Android ReaderView: read-only access to an immutable
// ReaderSnapshot (held through a heap shared_ptr handle) and the shared
// ReaderTracker. See reader/ReaderRegistry.h and reader/ReaderTracker.h.
#include <jni.h>
#include "jni/jni_utf8.h"

#include <memory>
#include <string>
#include <vector>

#include "image/ImageRegistry.h"
#include "reader/ReaderRegistry.h"
#include "reader/ReaderTracker.h"

namespace rdr = sherpa_onnx::reader;

namespace {

using SnapPtr = std::shared_ptr<const rdr::ReaderSnapshot>;

const rdr::ReaderSnapshot* Snap(jlong h) {
  auto* p = reinterpret_cast<SnapPtr*>(h);
  return p ? p->get() : nullptr;
}

std::string Std(JNIEnv* env, jstring js) {
  if (!js) return {};
  const char* c = env->GetStringUTFChars(js, nullptr);
  std::string s = c ? c : "";
  if (c) env->ReleaseStringUTFChars(js, c);
  return s;
}

jintArray Ints(JNIEnv* env, const std::vector<jint>& v) {
  jintArray out = env->NewIntArray(static_cast<jsize>(v.size()));
  if (!v.empty()) env->SetIntArrayRegion(out, 0, static_cast<jsize>(v.size()), v.data());
  return out;
}

}  // namespace

extern "C" {

// ---- Snapshot -----------------------------------------------------------

JNIEXPORT jlong JNICALL
Java_com_sherpaonnx_reader_ReaderViewNative_nativeSnapshotRetain(JNIEnv* env, jclass, jstring docId) {
  SnapPtr snap = rdr::ReaderRegistry::Instance().Snapshot(Std(env, docId));
  return snap ? reinterpret_cast<jlong>(new SnapPtr(std::move(snap))) : 0;
}

JNIEXPORT jlong JNICALL
Java_com_sherpaonnx_reader_ReaderViewNative_nativePlaceholderSnapshot(JNIEnv*, jclass, jint rows) {
  return reinterpret_cast<jlong>(new SnapPtr(rdr::MakePlaceholderSnapshot(rows)));
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_reader_ReaderViewNative_nativeSnapshotRelease(JNIEnv*, jclass, jlong h) {
  delete reinterpret_cast<SnapPtr*>(h);
}

/** 6 ints per block: type, headingLevel, section, imageFrame, imageWidth, imageHeight. */
JNIEXPORT jintArray JNICALL
Java_com_sherpaonnx_reader_ReaderViewNative_nativeBlockTable(JNIEnv* env, jclass, jlong h) {
  const auto* s = Snap(h);
  std::vector<jint> out;
  if (!s) return Ints(env, out);
  out.reserve(s->blocks.size() * 6);
  auto& images = sherpa_onnx::image::ImageRegistry::Instance();
  for (const auto& b : s->blocks) {
    int w = 0;
    int hgt = 0;
    if (b.imageFrame >= 0) {
      sherpa_onnx::image::ImageFrameInfo fi;
      if (images.GetFrameInfo(s->imageBufferId, b.imageFrame, fi)) {
        w = fi.width;
        hgt = fi.height;
      }
    }
    out.insert(out.end(), {static_cast<jint>(b.type), b.headingLevel, b.section, b.imageFrame, w, hgt});
  }
  return Ints(env, out);
}

/** 2 ints per section: firstBlock, blockCount. */
JNIEXPORT jintArray JNICALL
Java_com_sherpaonnx_reader_ReaderViewNative_nativeSectionTable(JNIEnv* env, jclass, jlong h) {
  const auto* s = Snap(h);
  std::vector<jint> out;
  if (s) {
    for (const auto& sec : s->sections) out.insert(out.end(), {sec.firstBlock, sec.blockCount});
  }
  return Ints(env, out);
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_reader_ReaderViewNative_nativeBlockId(JNIEnv* env, jclass, jlong h, jint i) {
  const auto* s = Snap(h);
  if (!s || i < 0 || i >= static_cast<jint>(s->blocks.size())) return nullptr;
  return sherpaonnx::NewJStringUtf8(env, s->blocks[i].id);
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_reader_ReaderViewNative_nativeSectionId(JNIEnv* env, jclass, jlong h, jint i) {
  const auto* s = Snap(h);
  if (!s || i < 0 || i >= static_cast<jint>(s->sections.size())) return nullptr;
  return sherpaonnx::NewJStringUtf8(env, s->sections[i].id);
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_reader_ReaderViewNative_nativeBlockText(JNIEnv* env, jclass, jlong h, jint i) {
  const auto* s = Snap(h);
  if (!s) return nullptr;
  return sherpaonnx::NewJStringUtf8(env, s->BlockText(i));
}

/** Alt text, or null when the image has none (decorative). */
JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_reader_ReaderViewNative_nativeBlockAlt(JNIEnv* env, jclass, jlong h, jint i) {
  const auto* s = Snap(h);
  if (!s || i < 0 || i >= static_cast<jint>(s->blocks.size()) || !s->blocks[i].hasAlt) return nullptr;
  return sherpaonnx::NewJStringUtf8(env, s->blocks[i].alt);
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_reader_ReaderViewNative_nativeImageBufferId(JNIEnv* env, jclass, jlong h) {
  const auto* s = Snap(h);
  return sherpaonnx::NewJStringUtf8(env, s ? s->imageBufferId : std::string());
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_reader_ReaderViewNative_nativeLanguage(JNIEnv* env, jclass, jlong h) {
  const auto* s = Snap(h);
  return sherpaonnx::NewJStringUtf8(env, s ? s->language : std::string());
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_reader_ReaderViewNative_nativeBlockIndex(JNIEnv* env, jclass, jlong h, jstring id) {
  const auto* s = Snap(h);
  return s ? s->BlockIndex(Std(env, id)) : -1;
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_reader_ReaderViewNative_nativeSectionIndex(JNIEnv* env, jclass, jlong h, jstring id) {
  const auto* s = Snap(h);
  return s ? s->SectionIndex(Std(env, id)) : -1;
}

// ---- Tracker ------------------------------------------------------------

JNIEXPORT jlong JNICALL
Java_com_sherpaonnx_reader_ReaderViewNative_nativeTrackerCreate(JNIEnv* env, jclass,
                                                                jintArray sectionLast,
                                                                jint threshold) {
  std::vector<int> last;
  if (sectionLast) {
    const jsize n = env->GetArrayLength(sectionLast);
    last.resize(n);
    env->GetIntArrayRegion(sectionLast, 0, n, last.data());
  }
  return reinterpret_cast<jlong>(new rdr::ReaderTracker(std::move(last), threshold));
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_reader_ReaderViewNative_nativeTrackerDestroy(JNIEnv*, jclass, jlong h) {
  delete reinterpret_cast<rdr::ReaderTracker*>(h);
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_reader_ReaderViewNative_nativeTrackerSetFrontier(JNIEnv*, jclass, jlong h,
                                                                     jint block) {
  if (auto* t = reinterpret_cast<rdr::ReaderTracker*>(h)) t->SetFrontier(block);
}

JNIEXPORT void JNICALL
Java_com_sherpaonnx_reader_ReaderViewNative_nativeTrackerSetThreshold(JNIEnv*, jclass, jlong h,
                                                                      jint blocks) {
  if (auto* t = reinterpret_cast<rdr::ReaderTracker*>(h)) t->SetJumpThreshold(blocks);
}

JNIEXPORT jint JNICALL
Java_com_sherpaonnx_reader_ReaderViewNative_nativeTrackerFrontier(JNIEnv*, jclass, jlong h) {
  auto* t = reinterpret_cast<rdr::ReaderTracker*>(h);
  return t ? t->Frontier() : -1;
}

/**
 * 6 ints per event: kind (0 visible, 1 furthest, 2 section end, 3 jump),
 * then visible: first, last, settled; furthest: block; section end: block,
 * section; jump: from, to, distance, cause (0 scroll, 1 fling, 2 scrollTo).
 */
JNIEXPORT jintArray JNICALL
Java_com_sherpaonnx_reader_ReaderViewNative_nativeTrackerSample(JNIEnv* env, jclass, jlong h,
                                                                jint first, jint last, jint phase) {
  std::vector<jint> out;
  auto* t = reinterpret_cast<rdr::ReaderTracker*>(h);
  if (!t) return Ints(env, out);
  for (const auto& e : t->Sample(first, last, static_cast<rdr::ScrollPhase>(phase))) {
    switch (e.kind) {
      case rdr::TrackerEvent::Kind::VisibleRange:
        out.insert(out.end(), {0, e.first, e.last, e.settled ? 1 : 0, 0, 0});
        break;
      case rdr::TrackerEvent::Kind::Furthest:
        out.insert(out.end(), {1, e.block, 0, 0, 0, 0});
        break;
      case rdr::TrackerEvent::Kind::SectionEnd:
        out.insert(out.end(), {2, e.block, e.section, 0, 0, 0});
        break;
      case rdr::TrackerEvent::Kind::Jump: {
        const int cause = e.cause == "fling" ? 1 : e.cause == "scrollTo" ? 2 : 0;
        out.insert(out.end(), {3, e.from, e.to, e.distance, cause, 0});
        break;
      }
    }
  }
  return Ints(env, out);
}

}  // extern "C"
