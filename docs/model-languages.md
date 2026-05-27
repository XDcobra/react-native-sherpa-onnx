# Model language helpers

## Introduction

**Import path:** `react-native-sherpa-onnx/model-languages`

This module provides language tables and normalized language-hint utilities used by STT/TTS/alignment integrations. It is intended for picker UI and model-option wiring.

> [!CAUTION]
> The APIs in this module are convenience helpers only. They return commonly referenced language codes and labels, not a guarantee that a specific checkpoint supports every entry. Confirm supported languages in upstream model documentation for your exact model bundle.

## Quick start

### Fun-ASR language hint to modelOptions mapping

`resolvePublicLanguageHints` returns `{ iso6391Hint, id }[]`: use `iso6391Hint` for catalog/filter UI and `id` for model options where required.

```ts
import { resolvePublicLanguageHints } from 'react-native-sherpa-onnx/model-languages';
import { ModelCategory } from 'react-native-sherpa-onnx/download';

const rows = resolvePublicLanguageHints({
  domain: ModelCategory.Stt,
  modelType: 'funasr_nano',
});

for (const row of rows) {
  console.log(row.iso6391Hint, row.id);
}
```

## API reference

### `resolvePublicLanguageHints(input)`

```ts
function resolvePublicLanguageHints(input: {
  domain: ModelCategory;
  modelType?: string;
  modelKey?: string;
  rawFromNative?: readonly string[];
}): Array<{
  iso6391Hint: string;
  id: string;
}>;
```

```ts
const hints = resolvePublicLanguageHints({
  domain: ModelCategory.Stt,
  modelType: 'whisper',
});
console.log(hints);
```

Resolves normalized public language tags. For stacks with curated language ids (for example Fun-ASR), `id` is the value intended for `modelOptions`.

### STT getter APIs

```ts
function getWhisperLanguages(): readonly ModelLanguage[];
function getSenseVoiceLanguages(): readonly ModelLanguage[];
function getCanaryLanguages(): readonly ModelLanguage[];
function getFunasrNanoLanguages(): readonly ModelLanguage[];
function getFunasrMltNanoLanguages(): readonly ModelLanguage[];
function getCohereTranscribeLanguages(): readonly ModelLanguage[];
function getQwen3AsrLanguages(): readonly ModelLanguage[];
function getDolphinInfoLanguages(): readonly ModelLanguage[];
```

```ts
const whisper = getWhisperLanguages();
console.log(whisper[0]?.id, whisper[0]?.name);
```

These getters return static language tables from the package and are suitable for building language pickers.

### Hint helpers for TTS and alignment

```ts
function iso6391HintsForTtsModelType(
  modelType?: string,
  modelKey?: string
): readonly string[];
function iso6391HintsForAlignmentModelType(modelType?: string): readonly string[];
```

```ts
const alignmentHints = iso6391HintsForAlignmentModelType('wav2vec2');
console.log(alignmentHints);
```

These helpers expose normalized public language hints by model type; they do not validate on-disk model folders.

## Types and constants

```ts
import {
  resolvePublicLanguageHints, // normalize and map language hints for model categories
  getWhisperLanguages, // Whisper language table getter
  getSenseVoiceLanguages, // SenseVoice language table getter
  getCanaryLanguages, // Canary language table getter
  getFunasrNanoLanguages, // Fun-ASR Nano language table getter
  getFunasrMltNanoLanguages, // Fun-ASR MLT Nano language table getter
  getCohereTranscribeLanguages, // Cohere Transcribe language table getter
  getQwen3AsrLanguages, // Qwen3 ASR language table getter
  getDolphinInfoLanguages, // Dolphin informational language list getter
  iso6391HintsForTtsModelType, // TTS public language hint resolver by model type
  iso6391HintsForAlignmentModelType, // alignment public language hint resolver by model type
  WHISPER_LANGUAGES, // Whisper language constants
  SENSEVOICE_LANGUAGES, // SenseVoice language constants
  CANARY_LANGUAGES, // Canary language constants
  FUNASR_NANO_LANGUAGES, // Fun-ASR Nano language constants
  FUNASR_MLT_NANO_LANGUAGES, // Fun-ASR MLT Nano language constants
  COHERE_TRANSCRIBE_LANGUAGES, // Cohere Transcribe language constants
  QWEN3_ASR_LANGUAGES, // Qwen3 ASR language constants
  DOLPHIN_INFO_LANGUAGES, // Dolphin informational language constants
  POCKET_TTS_ISO6391_HINTS, // Pocket TTS ISO639-1 hints
  SUPERTONIC_TTS_ISO6391_HINTS, // Supertonic (legacy) TTS ISO639-1 hints
  SUPERTONIC3_TTS_ISO6391_HINTS, // Supertonic 3 multilingual + na
  isSupertonic3ModelKey, // true when catalog/folder id denotes Supertonic 3
} from 'react-native-sherpa-onnx/model-languages';

import type {
  ModelLanguage, // language row shape: id + name
  PublicLanguageHint, // normalized hint row: iso6391Hint + id
  ResolvePublicLanguageHintsInput, // input shape for resolvePublicLanguageHints
} from 'react-native-sherpa-onnx/model-languages';
```

## Error codes

This module is table/transform based and does not define dedicated `*_ERROR` constants. Errors may still surface from caller-side validation or unsupported model-option combinations in feature modules (`stt`, `tts`, `alignment`).

## See also

- [Speech-to-Text (STT)](stt-offline.md) — `createSTT`, `detectSttModel`, `modelOptions`
- [Offline TTS](tts-offline.md)
- [Alignment (offline)](alignment-offline.md)

## Use case examples

<details>
<summary>Build a language picker for Whisper and pass selected id to modelOptions</summary>

```ts
const rows = getWhisperLanguages();
const selected = rows.find((r) => r.id === 'en') ?? rows[0];

await stt.transcribe(audioIn, textOut, {
  modelOptions: {
    whisper: { language: selected.id },
  },
});
```

</details>

<details>
<summary>Resolve public language hints from model detection metadata</summary>

```ts
const hints = resolvePublicLanguageHints({
  domain: ModelCategory.Stt,
  modelType: detection.modelType,
  rawFromNative: detection.languages,
});

console.log(hints.map((h) => `${h.iso6391Hint}:${h.id}`));
```

</details>

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK **last-activity ring buffer** (enabled by default when the native library loads). Full details: [native-diagnostics.md](./native-diagnostics.md) — Android log tag `SherpaNativeDiag`; iOS subsystem `com.sherpaonnx.diag`. Optional JS: `getNativeDiagnosticSnapshot` / `configureNativeDiagnostics` from `react-native-sherpa-onnx/diagnostics`.

