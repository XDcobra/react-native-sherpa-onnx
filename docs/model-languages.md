# Model language helpers

Language catalog, normalized hints, and picker UI wiring.

**Import:** `react-native-sherpa-onnx/model-languages`

| Doc | Question it answers |
| --- | --- |
| [model-detect.md](model-detect.md) | What model type / category is this pack? |
| **This page** | Which language codes can I show in a picker? |
| [catalog/README.md](../catalog/README.md) | How to edit the JSON catalog and regenerate |
| Feature docs | Per-family `modelOptions` (e.g. `whisper.language`) |

> [!CAUTION]
> APIs here are **convenience helpers** — commonly referenced language codes and labels, not a guarantee that your exact checkpoint supports every entry. Confirm supported languages in upstream model documentation.

---

## Catalog (single source of truth)

Curated language lists live in [`catalog/model-language-catalog.json`](../catalog/model-language-catalog.json). A build step emits:

- C++ embed data used by native `detectTtsModel` / `detectSttModel` when folder heuristics return no tags
- TypeScript picker exports in `src/model-languages/generated/catalog.ts`

```bash
yarn generate:model-language-catalog   # after editing JSON
yarn check:model-language-catalog      # CI drift check
```

`detect*Model().languages` is authoritative: each entry is `{ iso6391Hint, id }` from native (heuristics + curated catalog).

---

## Quick start

### Whisper language picker → `modelOptions`

```typescript
import { getWhisperLanguages } from 'react-native-sherpa-onnx/model-languages';

const rows = getWhisperLanguages();
const selected = rows.find((r) => r.id === 'en') ?? rows[0];

await stt.transcribe(audioIn, textOut, {
  modelOptions: { whisper: { language: selected.id } },
});
```

### Normalize hints from detection metadata

```typescript
import { publicLanguageHintsFromNative } from 'react-native-sherpa-onnx/model-languages';
import { ModelCategory } from 'react-native-sherpa-onnx/download';

const hints = publicLanguageHintsFromNative({
  domain: ModelCategory.Stt,
  modelType: detection.modelType,
  rawRows: detection.languages ?? [],
});

for (const row of hints) {
  console.log(row.iso6391Hint, row.id); // iso6391Hint for UI filter; id for modelOptions
}
```

---

## Language tables overview

Static tables for building pickers (generated from the JSON catalog). Each returns `ModelLanguage[]` (`{ id, name }`).

| Getter | Model family | Notes |
| --- | --- | --- |
| `getWhisperLanguages()` | Whisper STT | Full multilingual set |
| `getSenseVoiceLanguages()` | SenseVoice STT | |
| `getCanaryLanguages()` | Canary STT | |
| `getFunasrNanoLanguages()` | Fun-ASR Nano (3 langs) | `pickerVariants.nano` in JSON |
| `getFunasrMltNanoLanguages()` | Fun-ASR MLT Nano (31 langs) | `pickerVariants.mlt` in JSON |
| `getCohereTranscribeLanguages()` | Cohere Transcribe | |
| `getQwen3AsrLanguages()` | Qwen3 ASR | |
| `getDolphinInfoLanguages()` | Dolphin (informational) | |
| `getPpocrLanguages()` | PP-OCR (OCR) | PP-OCRv6 family set (~49 ISO: `zh`/`en`/`ja` + 46 Latin) |
| `getDoctrLanguages()` | DocTR (OCR) | OnnxTR family set (15 Latin-European: `en`/`fr`/`de`/`pt` + 11 more) |

`doc_vlm` hints are `DOC_VLM_ISO6391_HINTS` (`en`, `ja`, `ar`, `zh`), not a `ModelLanguage[]` picker.

TTS / alignment / OCR hint helpers (ISO 639-1 strings only; for UI labels — runtime rows come from native detect):

| Function | Scope |
| --- | --- |
| `iso6391HintsForTtsModelType(modelType?, modelKey?)` | TTS families |
| `iso6391HintsForAlignmentModelType(modelType?, modelKey?)` | Alignment — **pack-first** from `scripts/alignment-models/sources.csv` `languages` column (via generator); family fallbacks only for explicit multilingual markers (`multilingual-56`, MMS FA), never bare `xlsr` |
| `iso6391HintsForOcrModelType(modelType?, modelKey?)` | OCR — **pack-first** from `scripts/ocr-models/sources.csv` `languages`; family fallback `ppocr`, `doctr`, `doc_vlm`, or `nemotron_parse`. `auto` and an omitted type still fall back to ppocr hints |

Constants (`WHISPER_LANGUAGES`, `POCKET_TTS_ISO6391_HINTS`, `WAV2VEC2_ALIGNMENT_ISO6391_HINTS`, `PPOCR_LANGUAGES`, `DOCTR_LANGUAGES`, `DOCTR_ISO6391_HINTS`, `DOC_VLM_ISO6391_HINTS`, …) mirror the getters — import when you need the raw array without a function call.

---

## API reference

### `publicLanguageHintsFromNative(input)`

```typescript
function publicLanguageHintsFromNative(input: {
  domain: ModelCategory;
  modelType?: string;
  modelKey?: string;
  rawRows?: readonly Array<{ iso6391Hint: string; id: string }>;
}): Array<{ iso6391Hint: string; id: string }>;
```

Normalizes `iso6391Hint` on structured native rows. Does **not** apply a TypeScript fallback or id mapping — curated rows are bundled in C++ detect.

`resolvePublicLanguageHints` remains as a deprecated alias.

---

### `resolvePublicLanguageHints(input)` (deprecated)

Same shape as `publicLanguageHintsFromNative`. Prefer the latter in new code.

```typescript
const rows = publicLanguageHintsFromNative({
  domain: ModelCategory.Stt,
  modelType: 'funasr_nano',
  rawRows: [],
});
```

---

### STT language getters

```typescript
function getWhisperLanguages(): readonly ModelLanguage[];
function getSenseVoiceLanguages(): readonly ModelLanguage[];
function getCanaryLanguages(): readonly ModelLanguage[];
function getFunasrNanoLanguages(): readonly ModelLanguage[];
function getFunasrMltNanoLanguages(): readonly ModelLanguage[];
function getCohereTranscribeLanguages(): readonly ModelLanguage[];
function getQwen3AsrLanguages(): readonly ModelLanguage[];
function getDolphinInfoLanguages(): readonly ModelLanguage[];
```

```typescript
const whisper = getWhisperLanguages();
console.log(whisper[0]?.id, whisper[0]?.name);
```

Static tables — suitable for dropdown / chip pickers. Does not validate on-disk model folders.

---

### TTS, alignment, and OCR hint helpers

```typescript
function iso6391HintsForTtsModelType(modelType?: string, modelKey?: string): readonly string[];
function iso6391HintsForAlignmentModelType(modelType?: string, modelKey?: string): readonly string[];
function getPpocrLanguages(): readonly ModelLanguage[];
function getDoctrLanguages(): readonly ModelLanguage[];
function iso6391HintsForOcrModelType(modelType?: string, modelKey?: string): readonly string[];
```

```typescript
const hints = iso6391HintsForAlignmentModelType('wav2vec2');
const ocrPack = iso6391HintsForOcrModelType('ppocr', 'ppocrv6-tiny'); // zh, en
const ocrPicker = getPpocrLanguages();
const doctrPicker = getDoctrLanguages();
const doctrMobile = iso6391HintsForOcrModelType('doctr', 'doctr-mobile'); // en, fr
const docVlm = iso6391HintsForOcrModelType('doc_vlm'); // en, ja, ar, zh
const granite = iso6391HintsForOcrModelType('doc_vlm', 'docvlm-granite-258m-fp32');
```

Normalized ISO 639-1 hints by model type — for catalog labels, not runtime validation. OCR detect prefers basename heuristics, then pack CSV, then the family list (`ppocr`, `doctr`, `doc_vlm`, or `nemotron_parse`). `en` is the supported language on the granite pack; `ja`, `ar`, and `zh` are experimental. `docVlm` and `granite` are the same four codes today. `nemotron_parse` hints are NVIDIA MOSCAR coverage collapsed to ISO 639-1 (plus `yue`); MOSCAR is synthetic, not a real-document guarantee.

---

## Types

```typescript
import type {
  ModelLanguage,              // { id: string; name: string }
  PublicLanguageHint,         // { iso6391Hint: string; id: string }
  ResolvePublicLanguageHintsInput,
} from 'react-native-sherpa-onnx/model-languages';
```

---

## See also

- [STT offline](stt-offline.md) — `modelOptions` per family
- [TTS offline](tts-offline.md) — lexicon languages from `detectTtsModel`
- [Alignment offline](alignment-offline.md)
- [OCR offline](ocr-offline.md) — pack language hints + `getPpocrLanguages` + `getDoctrLanguages` + `DOC_VLM_ISO6391_HINTS` / `iso6391HintsForOcrModelType('doc_vlm')`
- [Model detection](model-detect.md) — `languages` field on unified detect results
