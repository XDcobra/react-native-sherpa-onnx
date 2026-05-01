# Known issues (react-native-sherpa-onnx)

Short, SDK-facing notes so we do not lose track and others can find them quickly. For deep dives, follow the linked docs.

---

## Zipvoice: `lexicon.txt` must be present (upstream aborts if empty)

**Symptom:** App **crashes** (native `abort`, sometimes followed by libc FORTIFY mutex errors in unrelated threads) when initializing Zipvoice — e.g. after “Please provide lexicon.txt for this model” in logcat.

**Cause:** The sherpa-onnx Zipvoice implementation builds a **`MatchaTtsLexicon`**, which calls **`SHERPA_ONNX_EXIT(-1)`** when the lexicon path is empty. The **full** GitHub release tarball **`sherpa-onnx-zipvoice-zh-en-emilia.tar.bz2`** (`tts-models`) often **does not** ship `lexicon.txt` inside the extracted folder (only ONNX, `tokens.txt`, `pinyin.raw`, `espeak-ng-data`, etc.). That is why it looks “missing” — it was never in that package.

**Where k2-fsa actually gets `lexicon.txt` for zh-en Zipvoice**

1. **Generate it (canonical upstream method)** — In [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), run from the repo root:
   - `pip install pypinyin`
   - `python3 scripts/zipvoice/zh-en/generate_lexicon.py`  
   This writes **`lexicon.txt`** in the current working directory (Chinese coverage from `pypinyin` + phrase/user entries in that script). Copy that file next to your model’s `tokens.txt`. The same script is what CI uses when building the **distill** release bundles (see `.github/workflows/upload-zipvoice-models.yaml`).

2. **Copy from another k2-fsa bundle that includes it** — The **`sherpa-onnx-zipvoice-distill-int8-zh-en-emilia.tar.bz2`** and **`sherpa-onnx-zipvoice-distill-fp32-zh-en-emilia.tar.bz2`** assets on the **`tts-models`** release are assembled with `lexicon.txt` in the inner folder. You can extract **`…/lexicon.txt`** from one of those archives. Prefer this only if your **`tokens.txt`** matches the ZipVoice line those bundles use (when in doubt, regenerate with the script above).

3. **Not the same thing:** `https://github.com/k2-fsa/sherpa-onnx/releases/download/hr-files/lexicon.txt` is used in **nodejs HR-TTS examples**, not documented as the zh-en Zipvoice lexicon — do not assume it matches Emilia Zipvoice without verification.

**SDK:** Detection and validation **require** `lexicon` and `dataDir` for Zipvoice so initialization fails with a **clear error** instead of calling native code that aborts.

---

## Pocket TTS (voice cloning): fragile EOS and cross-platform drift

**What matters:** Pocket TTS relies on a **heuristic end-of-speech signal** (scalar threshold on LM logits in upstream sherpa-onnx). That makes **output length and quality sensitive** to small numeric differences: you can get **very short** chunks (early EOS) or **very long** ones (no EOS before `max_frames`).

**Cross-platform:** With the **same** reference WAV (same length, same printed aggregate stats) and the **same** Pocket config and models, **iOS and Android can still diverge**:

- The **float buffer** used after resample/trim is **not bit-identical** across platforms (e.g. different `voice_ref_hash` in diagnostics) --> **voice embedding** can differ.
- **LM trajectory / EOS timing** can differ --> **large differences in audio duration** for the same text (observed: one platform hitting `max_frames` on a chunk while the other exits much earlier). This persisted with **`provider=cpu`** on iOS, so it is **not** explained by “iOS always uses CoreML.”

**SDK / product angle:** Pocket **voice cloning on iOS** is **higher risk** for consistent QA than on Android in our testing. Apps that need dependable cloning UX on iOS may prefer **Zipvoice** for cloning there; Pocket remains an option especially on Android. See the full write-up for VoiceLab’s documented policy and next steps.

**Scope:** Behavior is driven by **sherpa-onnx** (model + C++ inference), not by the React Native bridge. There is no single-line SDK fix for the underlying **numerics / parity** problem.

**Full analysis** (diagnostics, what was ruled out, appendices including minor upstream guard notes):

--> **[Pocket TTS – investigation notes](#pocket-tts-voice-cloning-fragile-eos-and-cross-platform-drift)**

**Upstream:** [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) — broader discussion may include **EOS thresholding**, tests, and cross-platform determinism.

---
