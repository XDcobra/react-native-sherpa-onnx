# Pocket TTS (voice cloning): investigation notes & upstream issue

This document is the **single source of truth** for the Pocket TTS / EOS / cross-platform work in **react-native-sherpa-onnx** and VoiceLab: what went wrong, what we verified, what we learned, and what we do next.

**SDK-facing summary (English):** [KNOWN_ISSUES.md](./KNOWN_ISSUES.md) — short note focused on **heuristic EOS + cross-platform drift** (not the small upstream guard detail in Appendix A).

---

## TL;DR

1. **Upstream logic bug (real):** If EOS is detected at LM step `0`, the original guard `eos_step > 0` prevents the early-exit branch --> loop runs until `max_frames` (default 500) --> **~40 s @ 24 kHz** (~960k samples). **Fix:** use `eos_step >= 0` (see [Appendix A](#appendix-a-upstream-logic-bug-eos_step--0)).

2. **Separate issue (cross-platform):** Even with identical JS-visible ref audio (samples, SR, min/max/rms) and identical Pocket config, **iOS Simulator vs Android Emulator** can produce **different EOS logits** and different **`voice_ref_hash`** after resample --> **very different output length** for the same text (e.g. first sentence hits `max_frames` on iOS but exits early on Android). This is **not** explained by CoreML when `provider=cpu` (confirmed in logs).

3. **Product decision (path B):** Ship with **voice cloning on iOS only via Zipvoice**; on **Android**, **Zipvoice + Pocket** remain available. **Pocket voice cloning on iOS** is deferred until we can revisit with a dedicated test harness.

4. **Next steps:** File/upstream PR for `eos_step >= 0`; later, optional mini test app + investigate EOS threshold / numerics; keep this doc updated.

---

## Layered problem statement

### A) Deterministic logic bug (upstream)

In `GenerateSingleSentence`, early stop used `eos_step > 0`. When `eos_step == 0`, the code never breaks on EOS and consumes the full `max_frames` budget.

### B) Heuristic EOS (model / numerics)

EOS is inferred with a **scalar threshold** on the LM output, e.g. `p_logit[0] > -4` (see upstream `offline-tts-pocket-impl.h`). That is **fragile**:

- **Early** EOS (e.g. step 0) --> very few frames --> **short** output (sometimes “bad” audio).
- **No** EOS before `max_frames` --> **long** output (up to ~40 s per sentence chunk at 24 kHz).

### C) Cross-platform drift (VoiceLab observation)

Under “same” conditions (same model bundle names `lm_flow.onnx` / `lm_main.onnx`, `cpu`, same `GenerationConfig` extras, same text chunking, same ref file length and **same printed** min/max/rms):

- **`voice_ref_hash`** (hash of **float** samples used after resample + trim) **differed** between iOS Simulator and Android Emulator --> buffers are **not bit-identical**; voice embedding can diverge.
- **Sentence 1/3:** iOS hit **`hit_max_frames`** (500 LM steps) --> **40 s** audio for that chunk; Android detected EOS around **step 73** --> **~6.8 s** for the same chunk.

So: **parity of WAV + config ≠ parity of LM trajectory** across ABIs / ORT builds / float order.

### D) CoreML vs CPU (clarified)

VoiceLab logs showed **`requested provider='cpu'`** and **`effective config.model.provider='cpu'`**. The earlier hypothesis “iOS uses CoreML therefore different EOS” was **incorrect** for those runs.

---

## What we already tested

| Area | What we did |
|------|-------------|
| **Upstream guard** | Identified `eos_step > 0` vs `eos_step == 0`; local fix `eos_step >= 0` in vendored `offline-tts-pocket-impl.h`. |
| **Provider** | Confirmed TTS init on iOS passes through `cpu` when selected; wrapper logs requested + effective provider. |
| **Diagnostics** | Added **`PocketTTS diag`** logs (init, `generate`, chunk metadata, `voice_ref` stats + hash, embedding cache hit/miss, per-sentence EOS, `chunk_audio`, `generate_done`). iOS: **`[PocketTTS diag] ios_clone`** before generate; Android: **`android_init`** / **`android_pre_gen`**. |
| **Same ref file** | Reused the same reference WAV (349523 samples @ 16 kHz); JS min/max/rms matched across platforms. |
| **Same model bundle** | `sherpa-onnx-pocket-tts-2026-01-26` with `lm_flow.onnx`, `lm_main.onnx`, etc. |
| **Same generation params** | e.g. `frames_after_eos=12`, `max_frames=500`, `num_steps=5`, same 322-char text --> **3 chunks** with **identical `chunk_meta` previews** on iOS and Android. |
| **C++ desktop** | `pocket-tts-en-cxx-api` on Mac; default static ORT build did not expose CoreML EP the same way — not a substitute for VoiceLab iOS vs Android. |

---

## Knowledge gained

1. **`eos_step >= 0`** is the correct structural fix for “EOS at frame 0” locking the loop to `max_frames` (upstream-worthy).

2. **`frames_after_eos`** scales tail length after first EOS trigger; it does **not** fix spurious EOS at step 0 or missing EOS for 500 steps.

3. **40 s / ~960k samples** per chunk is a **fingerprint** of **`hit_max_frames`** (500 frames × decoder frame size at 24 kHz), not necessarily the only bug.

4. **Cross-platform:** aggregate stats (min/max/rms) can match while **hashes of the resampled reference** differ --> expect **non-deterministic parity** across iOS Simulator vs Android Emulator for Pocket cloning until investigated further.

5. **Pocket on iOS** in VoiceLab is **high risk for v1** from a QA/support perspective (length and quality swings); **Zipvoice** is the safer cloning path on iOS.

---

## Product decision (path B)

- **iOS:** Offer **voice cloning only via Zipvoice** (do not expose Pocket as a cloning option in UX, or gate it off with clear “unsupported” messaging).
- **Android:** Keep **Zipvoice + Pocket** as today, where Pocket behaved acceptably in testing.
- **Pocket iOS / cross-platform parity:** Explicit **follow-up** after the app is field-ready — not a release blocker for v1.

Document this in app copy / settings if users can choose engines.

---

## Next steps (tracked)

### Short term

- [ ] **Upstream:** Open PR or issue on [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) for **`eos_step >= 0`** (text in [Appendix B](#appendix-b-copy-paste-github-issue-for-k2-fsasherpa-onnx)).
- [ ] **VoiceLab:** Implement UX/engine policy **path B** (iOS cloning = Zipvoice only; Android unchanged).
- [ ] Remove or relax **temporary** hacks (e.g. default `frames_after_eos` injection for Pocket) once policy is clear — only if still present in app code.

### Medium term (post–v1)

- [ ] **Mini test app or CLI fixture:** fixed WAV + fixed text --> capture `PocketTTS diag` + output WAV + duration; run on **same physical device class** or document ABI explicitly.
- [ ] Optional: log **ORT version** and **embedding tensor hash** (first N floats) to separate “ref drift” vs “LM drift”.
- [ ] Consider upstream discussion: **configurable EOS threshold**, multi-step confirmation, or safer defaults — separate from the `eos_step` off-by-one.

### Long term / upstream collaboration

- Deterministic unit test: mock LM logits so EOS fires at step 0 and assert exit before `max_frames`.
- Revisit **int8 vs fp32** bundle parity if Android and iOS ever diverge on quantization.

---

## Appendix A: Upstream logic bug (`eos_step == 0`)

**File:** `sherpa-onnx/csrc/offline-tts-pocket-impl.h` — `OfflineTtsPocketImpl::GenerateSingleSentence`

**Before (bug):**

```cpp
if (eos_step > 0 && (step >= eos_step + frames_after_eos)) {
  break;
}
```

**After (fix):**

```cpp
if (eos_step >= 0 && (step >= eos_step + frames_after_eos)) {
  break;
}
```

`eos_step` is `-1` until the first time `p_logit[0] > -4`, then it becomes the current `step` (possibly `0`). Only `-1` should mean “EOS not yet observed.”

---