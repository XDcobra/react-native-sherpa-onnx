# Known issues (react-native-sherpa-onnx)

Short, SDK-facing notes so we do not lose track and others can find them quickly. For deep dives, follow the linked docs.

---

## Pocket TTS (voice cloning): fragile EOS and cross-platform drift

**What matters:** Pocket TTS relies on a **heuristic end-of-speech signal** (scalar threshold on LM logits in upstream sherpa-onnx). That makes **output length and quality sensitive** to small numeric differences: you can get **very short** chunks (early EOS) or **very long** ones (no EOS before `max_frames`).

**Cross-platform:** With the **same** reference WAV (same length, same printed aggregate stats) and the **same** Pocket config and models, **iOS and Android can still diverge**:

- The **float buffer** used after resample/trim is **not bit-identical** across platforms (e.g. different `voice_ref_hash` in diagnostics) → **voice embedding** can differ.
- **LM trajectory / EOS timing** can differ → **large differences in audio duration** for the same text (observed: one platform hitting `max_frames` on a chunk while the other exits much earlier). This persisted with **`provider=cpu`** on iOS, so it is **not** explained by “iOS always uses CoreML.”

**SDK / product angle:** Pocket **voice cloning on iOS** is **higher risk** for consistent QA than on Android in our testing. Apps that need dependable cloning UX on iOS may prefer **Zipvoice** for cloning there; Pocket remains an option especially on Android. See the full write-up for VoiceLab’s documented policy and next steps.

**Scope:** Behavior is driven by **sherpa-onnx** (model + C++ inference), not by the React Native bridge. There is no single-line SDK fix for the underlying **numerics / parity** problem.

**Full analysis** (diagnostics, what was ruled out, appendices including minor upstream guard notes):

→ **[Pocket TTS – investigation notes](./github-issue-pocket-tts-eos-frame-zero.md)**

**Upstream:** [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) — broader discussion may include **EOS thresholding**, tests, and cross-platform determinism.

---
