# Known issues (react-native-sherpa-onnx)

Short, SDK-facing notes so we do not lose track and others can find them quickly. For deep dives, follow the linked docs.

---

## Zipvoice: lexicon optional at init (2.0.1 no longer aborts)

**Was:** older sherpa-onnx Zipvoice built a **`MatchaTtsLexicon`** and called **`SHERPA_ONNX_EXIT(-1)`** when the lexicon path was empty — init aborted the process.

**Now (sherpa-onnx 2.0.1):** lexicon is loaded only when the path is non-empty. Init succeeds without it. Raw text without a lexicon (and without `synthesize({ tokens })`) yields empty audio → `TTS_GENERATE_ERROR`. `espeak-ng-data` in Zipvoice packs is ignored.

The **full** GitHub tarball **`sherpa-onnx-zipvoice-zh-en-emilia.tar.bz2`** (`tts-models`) often **does not** ship `lexicon.txt` (only ONNX, `tokens.txt`, `pinyin.raw`, leftover `espeak-ng-data`, etc.).

**Where to get a zh-en Zipvoice lexicon**

1. **Generate it (canonical upstream method)** — In [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), from the repo root:
   - `pip install pypinyin`
   - `python3 scripts/zipvoice/zh-en/generate_lexicon.py`  
   Copy the written **`lexicon.txt`** next to `tokens.txt`, or pass it as `customConfig.lexicon`.

2. **Copy from a distill bundle** — **`sherpa-onnx-zipvoice-distill-int8-zh-en-emilia.tar.bz2`** / **`…-fp32-…`** on the **`tts-models`** release include `lexicon.txt`. Prefer this only if `tokens.txt` matches.

3. **Not the same thing:** `https://github.com/k2-fsa/sherpa-onnx/releases/download/hr-files/lexicon.txt` is for nodejs HR-TTS examples, not documented as the Emilia Zipvoice lexicon.

**SDK:** Zipvoice `lexicon` is optional at detect/validate/init. Put `lexicon.txt` / `lexicon-*.txt` in the model folder (auto) or set `customConfig.lexicon`. For pre-tokenized ZipVoice input, use `synthesize({ tokens })`.

---

## KWS: invalid `keywordsPath` / OOV tokens at spotter construction (upstream `_Exit`)

**Symptom:** App dies with `EXIT_SELF` / Zygote `exited cleanly (255)` and **empty** `adb logcat -b crash`. Logcat often shows `Encode keywords failed.` / `Cannot find ID for token …` immediately before death. No Java/Kotlin exception.

**Cause:** Upstream `KeywordSpotter` `InitKeywords` (from `keywordsFile`) calls **`SHERPA_ONNX_EXIT(-1)`** → `_Exit(-1)` when any keyword token is missing from pack `tokens.txt`. Common trigger: re-init with a **different language pack** while still pointing init at English ARPAbet (or other OOV) keywords from a previous session.

**SDK mitigation:** `createKeywordSpotting` always constructs the spotter with the **pack** `keywords.txt`. Optional `keywordsPath` (and `spot({ keywords })`) are applied via **`createStream`**, which returns null on encode failure — surfaced as a Promise rejection instead of killing the process.

**App guidance:** Prefer `spot({ keywords })` for open-vocab overrides. Keep keyword tokens in the pack’s inventory (use `text2token` against that pack’s `tokens.txt`). See [Streaming KWS](kws-streaming.md).

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
