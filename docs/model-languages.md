# Model language helpers

**Import path:** `react-native-sherpa-onnx/model-languages`

> [!CAUTION]
> The APIs in this module are **convenience helpers only**. They return **commonly referenced** language codes and labels for building dropdowns or hints — **not** a guarantee that a **specific** checkpoint or bundle you use supports every entry. To be **sure** which languages your model supports, open the **official model / release documentation** (e.g. sherpa-onnx release page, upstream model card, or project README) and verify supported languages there.

---

## Quick example (Fun-ASR)

`resolvePublicLanguageHints` returns **`{ iso6391Hint, id }[]`**: use **`iso6391Hint`** like a catalog tag (`zh`, `en`); use **`id`** in **`modelOptions`** (for Fun-ASR, the Chinese label from the list, e.g. **`中文`**). Direct **`getFunasrNanoLanguages()`** is still the source of truth for the full picker (**`name`**, every row); resolution ties each hint to one **`id`**.

```typescript
import { resolvePublicLanguageHints } from 'react-native-sherpa-onnx/model-languages';
import { ModelCategory } from 'react-native-sherpa-onnx/download';

const rows = resolvePublicLanguageHints({
  domain: ModelCategory.Stt,
  modelType: 'funasr_nano',
});

for (const row of rows) {
  row.iso6391Hint; // 'zh' | 'en' | … — coarse tag, same idea as detectSttModel().languages
  row.id; // '中文' | '英文' | … — pass to modelOptions.funasrNano.language, not the hint
}
```

---

## STT: list getters and `modelOptions`

| Model | Getter | Typical use |
| --- | --- | --- |
| Whisper | `getWhisperLanguages()` | `modelOptions.whisper.language` |
| SenseVoice | `getSenseVoiceLanguages()` | `modelOptions.senseVoice.language` |
| Canary | `getCanaryLanguages()` | `modelOptions.canary.srcLang` / `tgtLang` |
| Fun-ASR Nano | `getFunasrNanoLanguages()` | `modelOptions.funasrNano.language` |
| Fun-ASR MLT Nano | `getFunasrMltNanoLanguages()` | `modelOptions.funasrNano.language` |
| Cohere Transcribe (14-lang) | `getCohereTranscribeLanguages()` | `modelOptions.cohereTranscribe.language` |
| Qwen3 ASR | `getQwen3AsrLanguages()` | Informational only — no Qwen3 language field in `modelOptions` here |
| Dolphin | `getDolphinInfoLanguages()` | Informational only — not passed to native ([sherpa-onnx#2293](https://github.com/k2-fsa/sherpa-onnx/issues/2293)) |

---

## See also

- [Speech-to-Text (STT)](stt-offline.md) — `createSTT`, `detectSttModel`, `modelOptions`
- [Offline TTS](tts-offline.md)
- [Migration](migration.md)
