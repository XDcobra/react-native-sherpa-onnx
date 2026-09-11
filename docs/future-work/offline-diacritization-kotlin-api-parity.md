# Upstream: OfflineDiacritization Kotlin API parity

**Status:** Blocked / waiting on upstream (or our prebuilt packaging fix).  
**Priority:** Prerequisite for SDK Diacritization — **do not** implement `feat/add-diacritization-feature` until this lands in the Maven `classes.jar` we ship.  
**Research date:** 2026-09-11  
**Related:** [diacritization-plan.md](../internal/diacritization-plan.md) (SDK feature plan — deferred), [k2-fsa/sherpa-onnx#3669](https://github.com/k2-fsa/sherpa-onnx/pull/3669) (Java bindings only).

---

## 1. Problem

sherpa-onnx already has **offline CATT diacritization** end-to-end in native code:

| Layer | Status (as of `v1.13.7` / `v1.13.8` / `master`) |
| --- | --- |
| C / CXX API | ✅ Present |
| JNI (`offline-diacritization.cc`) | ✅ Present (`Java_com_k2fsa_sherpa_onnx_OfflineDiacritization_*`) |
| **`java-api/`** | ✅ `OfflineDiacritization.java` + Config / ModelConfig |
| **`kotlin-api/`** | ❌ **No** `OfflineDiacritization.kt` (and no diacrit mentions) |

Our Android Maven AAR (`com.xdcobra.sherpa:sherpa-onnx`) packages **`kotlin-api` → `classes.jar` by default**. Verified on published **`1.13.7-1`**:

- JNI `.so` **includes** OfflineDiacritization symbols  
- AAR `c-api/*.h` **includes** the C API  
- `classes.jar` has **0** `OfflineDiacritization*.class` (while Punctuation / AudioTagging **are** present)

So the gap is **not** “wrong sherpa version” and **not** a stale local extract — it is **API surface asymmetry**: Java got bindings in [#3669](https://github.com/k2-fsa/sherpa-onnx/pull/3669); Kotlin never did. Contrast Punctuation / AudioTagging, which exist in **both** `java-api` and `kotlin-api`.

---

## 2. Goal

Ship Kotlin wrappers that match the existing Java/JNI contract so our default AAR `classes.jar` exposes:

```text
OfflineDiacritization
OfflineDiacritizationConfig
OfflineDiacritizationModelConfig
→ addDiacritics(text: String): String
```

…with the same init fields as Java (`cattEncoder`, `cattDecoder`, `numThreads`, `provider`, `debug`), following the style of `OfflinePunctuation.kt`.

After that, republish the Maven AAR (e.g. `1.13.7-2` or next pin) and only then resume the SDK feature plan.

---

## 3. Preferred path (upstream)

1. Open / land a **k2-fsa/sherpa-onnx** PR adding Kotlin API files under `sherpa-onnx/kotlin-api/`, mirroring `java-api` + JNI method names (same pattern as `OfflinePunctuation.kt` ↔ `OfflinePunctuation.java`).
2. Bump `third_party/sherpa-onnx` and rebuild via `third_party/sherpa-onnx-prebuilt` → publish `com.xdcobra.sherpa:sherpa-onnx`.
3. Confirm `jar tf …/classes.jar | grep OfflineDiacritization` is non-empty; smoke `addDiacritics` on device.

**Acceptance:**

- [ ] `OfflineDiacritization.kt` (+ config types) on upstream `master` (or our fork until merged)
- [ ] Published Maven AAR `classes.jar` contains the new classes
- [ ] JNI symbols still resolve (no packaging regression)
- [ ] Short Android smoke (Java example parity: undiacritized Arabic → diacritized string)

---

## 4. Fallback paths (only if upstream is slow)

| Option | Notes |
| --- | --- |
| **A. Patch kotlin-api in our build tree** | Add the `.kt` files under `third_party/sherpa-onnx` (or prebuilt overlay) before `kotlin-api-build` jar; publish Maven. Prefer contributing upstream afterward. |
| **B. Ship `java-api` classes into AAR** | `build_sherpa_onnx.sh --java` / `--both` + package Java OfflineDiacritization into the jar we consume. Works, but diverges from “Kotlin API is the AAR default” for one feature. |
| **C. Hand-written thin Kotlin JNI wrappers in the RN module** | Last resort — duplicates upstream surface; avoid unless packaging is blocked. |

Do **not** reimplement CATT via raw ORT in the RN SDK.

---

## 5. Explicit non-goals (this note)

- Implementing SDK `createOfflineDiacritization` / LiveText overload (see deferred [diacritization-plan.md](../internal/diacritization-plan.md))
- Collect / license / detect / example screen
- CATT ED (encoder–decoder) packs
- Inventing `OnlineDiacritization`

---

## 6. Unblock checklist for Diacritization feature work

1. Kotlin (or packaged Java) OfflineDiacritization visible in Maven `classes.jar` we pin  
2. iOS C-API already OK on current xcframework — no change required for this note  
3. Resume [diacritization-plan.md](../internal/diacritization-plan.md) Phase 1+
