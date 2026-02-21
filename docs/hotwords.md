# Hotwords (contextual biasing)

> **Transducer and NeMo transducer** (`transducer`, `nemo_transducer`) support hotwords in sherpa-onnx (NeMo support added in [sherpa-onnx#3077](https://github.com/k2-fsa/sherpa-onnx/pull/3077)). All other model types (e.g. Whisper, Paraformer, Sense Voice) do not. The SDK validates and rejects with:

| Code | When |
| --- | --- |
| `HOTWORDS_NOT_SUPPORTED` | `initializeSTT` or `setSttConfig` is called with a non-empty `hotwordsFile` (or merged config has a hotword file) and the current model type is not `transducer` or `nemo_transducer`. |
| `INVALID_HOTWORDS_FILE` | A hotwords file path is set but the file is missing, not readable, not valid UTF-8 text, contains null bytes, has no valid lines, a line with optional ` :score` has an invalid score, or a line has no letter characters (e.g. numbers-only or SRT timestamps). The message describes the specific issue. |

Use **`sttSupportsHotwords(modelType)`** (exported from `react-native-sherpa-onnx/stt`) to show hotword options only when the selected or detected model type supports them. The function returns `true` only for `'transducer'` and `'nemo_transducer'`.

**Auto-switch to modified_beam_search:** When you provide a non-empty hotwords file, the SDK **automatically** sets the decoding method to `modified_beam_search` (and ensures `maxActivePaths` is at least 4), because sherpa-onnx only applies hotwords with that method. You do not need to set `decodingMethod` manually. The init result includes `decodingMethod` so you can confirm which method was applied.

**Hotword file format (for transducer / nemo_transducer models):**

- **One word or phrase per line.** UTF-8 text; no null bytes.
- **Optional score per line:** `word_or_phrase :1.5` (space, colon, then a single number). If present, the part after ` :` must parse as a number.
- **Each non-empty line must contain at least one letter character.** Lines that are only digits, punctuation, or symbols (e.g. SRT-style timestamps) are rejected.

The SDK validates the file when you pass a path: it must exist, be readable, and satisfy the rules above. Invalid files cause rejection with `INVALID_HOTWORDS_FILE`.

**Modeling unit and BPE vocab (optional):** Only relevant if you use **hotwords**. Then you can pass **`modelingUnit`** (and if needed **`bpeVocab`**) so hotwords are tokenized correctly. See [sherpa-onnx hotwords](https://k2-fsa.github.io/sherpa/onnx/hotwords/index.html).

- **`modelingUnit`**: Set when using hotwords. `'cjkchar'` \| `'bpe'` \| `'cjkchar+bpe'`. Must match the model's training unit.
- **`bpeVocab`**: Only needed when `modelingUnit` is **`'bpe'`** or **`'cjkchar+bpe'`**. Path to the BPE vocabulary file (sentencepiece **bpe.vocab**). For **`'cjkchar'`** you do *not* need `bpeVocab`.

If the model directory contains **`bpe.vocab`**, it is detected automatically and used when `bpeVocab` is not provided (for `bpe` / `cjkchar+bpe`).

**When to use which `modelingUnit`:** The value depends on how the **model was trained**, not on the app. You find it in the model's documentation (e.g. k2-fsa releases, Hugging Face card).

| Use this | Typical models / hints |
| --- | --- |
| **`bpe`** | English (or similar) transducer: e.g. "zipformer-en", "icefall … en", LibriSpeech. Model often has **bpe.model** or **bpe.vocab** in the folder. Hotwords file: one word/phrase per line (e.g. `SPEECH RECOGNITION`). |
| **`cjkchar`** | Chinese character-based transducer: e.g. "conformer-zh", "wenetspeech", "multi-dataset zh". No BPE; tokens are characters. Hotwords file: Chinese words per line (e.g. `语音识别`). |
| **`cjkchar+bpe`** | Bilingual Chinese + English transducer: e.g. "bilingual-zh-en", "streaming zipformer bilingual". Model often has **bpe.vocab**. Hotwords can mix Chinese and English (e.g. `礼拜二`, `FOREVER`). |

If you're unsure: check the model's repo or README for "modeling unit", "tokenizer", or "BPE". If the folder contains **bpe.vocab** (or bpe.model), the model is usually **bpe** or **cjkchar+bpe**; then set **`modelingUnit`** and, if needed, **`bpeVocab`** (or rely on auto-detected **bpe.vocab**).
