// JNI for the Android ReaderView: read-only access to an immutable
// ReaderSnapshot (held through a heap shared_ptr handle) and the shared
// ReaderTracker. See reader/ReaderRegistry.h and reader/ReaderTracker.h.
#include <jni.h>
#include "jni/jni_utf8.h"

#include <memory>
#include <string>
#include <vector>

#include "image/ImageRegistry.h"
#include "reader/ReaderHighlights.h"
#include "reader/ReaderLayout.h"
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

/** 7 ints per block: type, headingLevel, section, imageFrame, imageWidth, imageHeight, flags. */
JNIEXPORT jintArray JNICALL
Java_com_sherpaonnx_reader_ReaderViewNative_nativeBlockTable(JNIEnv* env, jclass, jlong h) {
  const auto* s = Snap(h);
  std::vector<jint> out;
  if (!s) return Ints(env, out);
  out.reserve(s->blocks.size() * 7);
  auto& images = sherpa_onnx::image::ImageRegistry::Instance();
  for (const auto& b : s->blocks) {
    int w = 0;
    int hgt = 0;
    if (b.imageFrame >= 0) {
      sherpa_onnx::image::ImageFrameInfo fi;
      if (images.GetFrameInfo(s->imageBufferId, b.imageFrame, fi)) {
        // Lazy pages are laid out before they are decoded.
        w = fi.expectedWidth;
        hgt = fi.expectedHeight;
      }
    }
    out.insert(out.end(), {static_cast<jint>(b.type), b.headingLevel, b.section, b.imageFrame, w,
                           hgt, static_cast<jint>(b.flags)});
  }
  return Ints(env, out);
}

/** 4 ints per row: block, coverFirst, coverLast, page (1 = full-width page image). */
JNIEXPORT jintArray JNICALL
Java_com_sherpaonnx_reader_ReaderViewNative_nativePlanRows(JNIEnv* env, jclass, jlong h,
                                                           jstring mode) {
  const auto* s = Snap(h);
  std::vector<jint> out;
  if (!s) return Ints(env, out);
  const std::string m = Std(env, mode);
  const auto rows = rdr::PlanRows(*s, rdr::PageDisplayFromName(m.c_str()));
  out.reserve(rows.size() * 4);
  for (const auto& r : rows) out.insert(out.end(), {r.block, r.coverFirst, r.coverLast, r.page ? 1 : 0});
  return Ints(env, out);
}

/** [first, last] visible blocks of a row (see RowVisibleBlocks), or an empty array. */
JNIEXPORT jintArray JNICALL
Java_com_sherpaonnx_reader_ReaderViewNative_nativeRowVisibleBlocks(
    JNIEnv* env, jclass, jlong h, jint block, jint coverFirst, jint coverLast, jboolean page,
    jfloat visibleTop, jfloat visibleBottom, jfloat rowHeight, jfloat viewport) {
  const auto* s = Snap(h);
  std::vector<jint> out;
  const int n = s ? static_cast<int>(s->blocks.size()) : 0;
  if (!s || coverFirst < 0 || coverLast >= n || block < coverFirst || block > coverLast) {
    return Ints(env, out);
  }
  const rdr::ReaderRow row{block, coverFirst, coverLast, page == JNI_TRUE};
  int first = -1;
  int last = -1;
  if (rdr::RowVisibleBlocks(*s, row, visibleTop, visibleBottom, rowHeight, viewport, &first, &last)) {
    out = {first, last};
  }
  return Ints(env, out);
}

/** Offset in px from a row's top where `target` starts (page images; else 0). */
JNIEXPORT jfloat JNICALL
Java_com_sherpaonnx_reader_ReaderViewNative_nativeBlockOffsetInRow(JNIEnv*, jclass, jlong h,
                                                                   jint block, jboolean page,
                                                                   jint target, jfloat rowHeight) {
  const auto* s = Snap(h);
  if (!s) return 0;
  const rdr::ReaderRow row{block, block, block, page == JNI_TRUE};
  return rdr::BlockOffsetInRow(*s, row, target, rowHeight);
}

/** 4 floats per rect (x, y, w, h normalized to the page) of [start, end) of a block's text. */
JNIEXPORT jfloatArray JNICALL
Java_com_sherpaonnx_reader_ReaderViewNative_nativeTextRangeRects(JNIEnv* env, jclass, jlong h,
                                                                 jint block, jint start, jint end) {
  const auto* s = Snap(h);
  std::vector<jfloat> out;
  if (s) {
    for (const auto& r : rdr::TextRangeRects(*s, block, start, end)) {
      out.insert(out.end(), {r.x, r.y, r.w, r.h});
    }
  }
  jfloatArray arr = env->NewFloatArray(static_cast<jsize>(out.size()));
  if (!out.empty()) env->SetFloatArrayRegion(arr, 0, static_cast<jsize>(out.size()), out.data());
  return arr;
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

/** Inline styles of a block: (start, end, flags) per run, UTF-16 in the block text; flags 1 italic, 2 bold. */
JNIEXPORT jintArray JNICALL
Java_com_sherpaonnx_reader_ReaderViewNative_nativeBlockStyles(JNIEnv* env, jclass, jlong h, jint i) {
  const auto* s = Snap(h);
  std::vector<jint> out;
  if (!s || i < 0 || i >= static_cast<jint>(s->blocks.size())) return Ints(env, out);
  const auto& styles = s->blocks[i].styles;
  out.reserve(styles.size() * 3);
  for (const auto& r : styles) {
    out.insert(out.end(), {r.start, r.end, static_cast<jint>(r.flags)});
  }
  return Ints(env, out);
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
 * section; jump: from, to, distance, cause (0 scroll, 1 fling, 2 scrollTo, 3 follow).
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
        const int cause = e.cause == "fling"      ? 1
                          : e.cause == "scrollTo" ? 2
                          : e.cause == "follow"   ? 3
                                                  : 0;
        out.insert(out.end(), {3, e.from, e.to, e.distance, cause, 0});
        break;
      }
    }
  }
  return Ints(env, out);
}

/**
 * Resolves highlights (parallel arrays, one entry per highlight; style 0
 * background, 1 underline, 2 text color; flags bit 0 hasColor, bit 1 follow).
 * Result ints: followBlock, followOffset, invalidCount, invalid input indices…,
 * then per block: block, spanCount, (start, end, style, color, hasColor)…
 */
JNIEXPORT jintArray JNICALL
Java_com_sherpaonnx_reader_ReaderViewNative_nativeResolveHighlights(
    JNIEnv* env, jclass, jlong h, jobjectArray ids, jobjectArray fromIds, jintArray fromOffsets,
    jobjectArray toIds, jintArray toOffsets, jintArray styles, jintArray colors, jintArray flags) {
  std::vector<jint> out;
  const auto* s = Snap(h);
  const jsize n = ids ? env->GetArrayLength(ids) : 0;
  auto ints = [env, n](jintArray a) {
    std::vector<jint> v(n, 0);
    if (a && env->GetArrayLength(a) >= n && n > 0) env->GetIntArrayRegion(a, 0, n, v.data());
    return v;
  };
  auto str = [env](jobjectArray a, jsize i) {
    auto* js = static_cast<jstring>(env->GetObjectArrayElement(a, i));
    std::string r = Std(env, js);
    if (js) env->DeleteLocalRef(js);
    return r;
  };
  if (!s) {
    out.insert(out.end(), {-1, 0, 0});
    return Ints(env, out);
  }
  const auto fo = ints(fromOffsets), to = ints(toOffsets), st = ints(styles), co = ints(colors),
             fl = ints(flags);
  std::vector<rdr::HighlightInput> inputs(n);
  for (jsize i = 0; i < n; ++i) {
    auto& in = inputs[i];
    in.id = str(ids, i);
    in.fromBlockId = str(fromIds, i);
    in.fromOffset = fo[i];
    in.toBlockId = str(toIds, i);
    in.toOffset = to[i];
    in.style = static_cast<rdr::HighlightStyle>(st[i] >= 0 && st[i] <= 2 ? st[i] : 0);
    in.color = static_cast<uint32_t>(co[i]);
    in.hasColor = (fl[i] & 1) != 0;
    in.follow = (fl[i] & 2) != 0;
  }
  const rdr::ResolvedHighlights r = rdr::ResolveHighlights(*s, inputs);
  std::vector<jint> invalid;
  for (jsize i = 0; i < n; ++i) {
    for (const auto& id : r.invalidIds) {
      if (id == inputs[i].id) {
        invalid.push_back(i);
        break;
      }
    }
  }
  out.insert(out.end(), {r.followBlock, r.followOffset, static_cast<jint>(invalid.size())});
  out.insert(out.end(), invalid.begin(), invalid.end());
  for (const auto& [block, spans] : r.byBlock) {
    out.push_back(block);
    out.push_back(static_cast<jint>(spans.size()));
    for (const auto& sp : spans) {
      out.insert(out.end(), {sp.start, sp.end, static_cast<jint>(sp.style), static_cast<jint>(sp.color),
                             sp.hasColor ? 1 : 0});
    }
  }
  return Ints(env, out);
}

}  // extern "C"
