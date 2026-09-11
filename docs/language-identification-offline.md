# Spoken language identification (offline)

## Introduction

On-device **spoken language identification** using **Whisper multilingual** models. Returns ISO 639-1 codes (e.g. `en`, `zh`, `de`).

For **live overload** (same offline weights on live buffers — not a true streaming model), see [Spoken language identification (live overload)](language-identification-live.md).

| Role | Type | Notes |
| --- | --- | --- |
| **Audio in** | [`OfflineAudioBuffer`](audiobuffer-offline.md) | Short clip (oneshot) or long-form (segmented) |
| **Segments out (optional)** | [`OfflineSegmentBuffer`](segmentbuffer-offline.md) | `payload.source: 'languageId'`, `lang` |
| **Engine** | `LanguageIdentificationEngine` via `createLanguageIdentification` | `identify` oneshot / segmented; `labelOfflineSegments` |

Import path: **`react-native-sherpa-onnx/language-identification`**.

Sherpa-onnx exposes SLID **only as offline** Whisper (no online SLID model). This SDK adds:

1. **Oneshot** — single pass ≤ ~30 s (native Whisper truncate).
2. **Segmented** — [segmentation engine](segmentation-engine.md) slices long audio; duration-weighted `distribution` + `switches`.

## Quick start — oneshot

```ts
import {
  createLanguageIdentification,
  detectLanguageIdModel,
} from 'react-native-sherpa-onnx/language-identification';
import {
  createOfflineAudioBufferFromFile,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';

const modelDir = {
  kind: 'fs' as const,
  path: '/absolute/path/to/whisper-multilingual-dir',
};

const det = await detectLanguageIdModel(modelDir, { modelType: 'auto' });
if (!det.success) throw new Error(det.error ?? 'Language ID detection failed');

const slid = await createLanguageIdentification({
  modelSource: modelDir,
  quantization: det.quantization ?? 'auto',
  numThreads: 2,
});

try {
  const audio = await createOfflineAudioBufferFromFile({
    kind: 'fs',
    path: '/absolute/path/clip.wav',
  });
  const result = await slid.identify(audio);
  console.log(result.lang, result.audioDuration, result.elapsedMs);
  await releasePipelineAudioBuffer(audio);
} finally {
  await slid.destroy();
}
```

## Quick start — segmented (code-switching)

```ts
import { DEFAULT_LANGUAGE_ID_SEGMENTATION_POLICY } from 'react-native-sherpa-onnx/language-identification';

const result = await slid.identify(audio, {
  segmentation: {
    mode: 'auto',
    policy: DEFAULT_LANGUAGE_ID_SEGMENTATION_POLICY,
  },
  onProgress: (p) => console.log(`${p.currentSegment + 1}/${p.totalSegments}`),
  onSegment: (e) => console.log('#', e.segmentIndex, e.lang),
  onLanguageChanged: (e) => console.log(e.previousLang, '→', e.currentLang),
});

console.log(result.dominantLanguage, result.distribution, result.switches.length);
```

Acoustic SLID is **inter-sentential** (segment-level). Word-level switching belongs to STT decoders.

Optional empty `targetSegmentBuffer` attaches `LanguageIdSpeechSegmentPayload` for downstream pipelines (e.g. Audio → VAD → Language ID → STT).

---

## Buffer matrix

| | Oneshot | Segmented |
| --- | --- | --- |
| **Audio in** | `OfflineAudioBuffer` | `OfflineAudioBuffer` |
| **Segments out** | optional `targetSegmentBuffer` | optional `targetSegmentBuffer` |
| **Return** | `{ lang, audioDuration, elapsedMs }` | `{ dominantLanguage, distribution, switches, segments, … }` |

---

## API reference

### `detectLanguageIdModel(source, options?)`

File-based detection **without** initializing the engine. Prefer before `createLanguageIdentification` to confirm pack layout and quantization. Unified detection: [model-detect.md](model-detect.md).

Packs require `model_type == "whisper"` and `is_multilingual == 1` metadata. Same layout as STT Whisper (encoder + decoder ONNX).

```ts
function detectLanguageIdModel(
  source: FileSource,
  options?: LanguageIdDetectOptions
): Promise<LanguageIdDetectResult>;
```

```ts
const det = await detectLanguageIdModel(
  { kind: 'fs', path: '/path/to/whisper-multilingual' },
  { modelType: 'auto' }
);
if (!det.success) throw new Error(det.error ?? 'Language ID detection failed');
```

### `createLanguageIdentification(options)`

Creates a `LanguageIdentificationEngine`. Init via `modelSource` (auto-detect) or `customConfig` (`{ encoder, decoder }` `FileSource` paths). Shared tuning: `quantization`, `numThreads`, `provider`, `tailPaddings`, `debug`.

```ts
function createLanguageIdentification(
  options: LanguageIdentificationInitializeOptions
): Promise<LanguageIdentificationEngine>;
```

```ts
const slid = await createLanguageIdentification({
  modelSource: { kind: 'fs', path: '/path/to/whisper-multilingual' },
  quantization: 'auto',
  numThreads: 2,
});
```

### `slid.identify(audio, options?)` — oneshot

Whole-clip offline Whisper SLID (≤ ~30 s; longer clips are truncated). Omit `segmentation` or set `mode: 'off'`. Does **not** emit `onProgress` / `onSegment`.

```ts
identify(
  audio: OfflineAudioBufferIdSource,
  options?: LanguageIdentificationOptions & { segmentation?: { mode?: 'off' } }
): Promise<LanguageIdentificationResult>;
```

```ts
const result = await slid.identify(audio);
console.log(result.lang, result.elapsedMs);
```

### `slid.identify(audio, options)` — segmented

`mode: 'auto'` + policy. Duration-weighted `distribution` / `switches`. Optional `onProgress` / `onSegment` / `onLanguageChanged` / `targetSegmentBuffer`.

```ts
identify(
  audio: OfflineAudioBufferIdSource,
  options: LanguageIdentificationOptions & {
    segmentation: { mode: 'auto'; policy?: SegmentationPolicy };
  }
): Promise<SegmentedLanguageIdentificationResult>;
```

```ts
const result = await slid.identify(audio, {
  segmentation: { mode: 'auto', policy: DEFAULT_LANGUAGE_ID_SEGMENTATION_POLICY },
  onSegment: (e) => console.log(e.segmentIndex, e.lang),
});
```

Live overload `identify(liveAudio, liveText, options)`: [language-identification-live.md](language-identification-live.md).

### `slid.labelOfflineSegments(audioIn, segmentsIn, segmentsOut, options?)`

Annotate existing speech segments with language labels without re-running segmentation. Reads spans from `segmentsIn`, evaluates each with Whisper SLID, writes `{ source: 'languageId', lang }` payloads to `segmentsOut`. Does not mutate `segmentsIn`.

```ts
labelOfflineSegments(
  audioIn: OfflineAudioBufferIdSource,
  segmentsIn: OfflineSegmentBufferIdSource,
  segmentsOut: OfflineSegmentBufferIdSource,
  options?: LanguageIdLabelOptions
): Promise<LabelOfflineSegmentsResult>;
```

```ts
const labeled = await slid.labelOfflineSegments(audioIn, segmentsIn, segmentsOut, {
  onSegment: (e) => console.log(e.lang),
  onLanguageChanged: (e) => console.log(e.previousLang, '→', e.currentLang),
});
console.log(labeled.labeledCount, labeled.dominantLanguage);
```

### `slid.destroy()`

Releases the native instance (joins any live workers first).

```ts
destroy(): Promise<void>;
```

```ts
await slid.destroy();
```

## Models and required files

| `modelType` | Required files | Custom-init keys |
| --- | --- | --- |
| `whisper` | `encoder` + `decoder` ONNX (same layout as STT Whisper) | `encoder`, `decoder` |

Validate category: **`languageId`**. Quantization: `'auto' | 'int8' | 'fp16' | 'fp32' | …`.

Download via `ModelCategory.LanguageId` (built-in GitHub source; see [download-manager.md](download-manager.md)).

---

## Offline JS events (`onProgress` / `onSegment` / `onLanguageChanged`)

### `onProgress` (start-of-step)

Multi-span SLID paths support optional coarse offline progress via `onProgress` on **segmented** `identify` and `labelOfflineSegments`. The payload is shared **`OrchestrationProgress`** (same fields as VAD offline / Alignment / SID):

- Fires at the **start** of step `i` (before native identify for that span).
- `fraction` follows `totalSegments > 0 ? currentSegment / totalSegments : 1`.
- `totalSegments` is the number of non-empty speech spans; `currentSegmentDurationMs` is that span's duration.
- Zero usable speech spans → **no** progress events (empty result / `labeledCount: 0`).
- Only **function** callbacks are registered. Non-function values are ignored (segmented `identify` may take the native fast-path with **no** JS events). If a callback throws, the run aborts.

Oneshot `identify` does **not** emit progress.

### `onSegment` (per-span result)

Fires **after** native identify for each speech span (and after staging append on `labelOfflineSegments`):

| Field | Meaning |
| --- | --- |
| `segmentIndex` / `totalSegments` | 0-based index and span count |
| `startTime` / `endTime` / `durationMs` | Span range in seconds / ms |
| `lang` | Predicted ISO 639-1 code (may be empty if identify returned nothing usable) |

Order per span: `onProgress` → identify → (`append` on label) → `onSegment` → maybe `onLanguageChanged`.

### `onLanguageChanged` (language transition)

Fires when the predicted `lang` for a span differs from the previous non-empty language (including the first span with a usable `lang`, where `previousLang` is `null`):

| Field | Meaning |
| --- | --- |
| `previousLang` | Prior language code, or `null` on the first transition |
| `currentLang` | New language code |
| `timestamp` | Span start time in seconds |
| `segmentIndex` | Span where the transition occurred |

Same chronological list is also available on the segmented result as `switches`.

```ts
await slid.identify(audio, {
  segmentation: { mode: 'auto', policy: DEFAULT_LANGUAGE_ID_SEGMENTATION_POLICY },
  onProgress: (p) => console.log(`slid ${p.currentSegment + 1}/${p.totalSegments}`),
  onSegment: (e) => console.log(`#${e.segmentIndex} lang=${e.lang} (${e.durationMs}ms)`),
  onLanguageChanged: (e) => console.log(`${e.previousLang ?? '—'} → ${e.currentLang}`),
});
```

Live overload uses `onSegment` / `onLanguageChanged` only (no offline `onProgress`) — see [language-identification-live.md](language-identification-live.md).

---

## Speech payload (`source: 'languageId'`)

```ts
{ source: 'languageId'; lang: string }
```

See [segmentbuffer-offline.md](segmentbuffer-offline.md).

---

## Types

### Core language-identification types (`react-native-sherpa-onnx/language-identification`)

| Type | Description |
| --- | --- |
| `LanguageIdModelType` | `'whisper'` |
| `LANGUAGE_ID_MODEL_TYPES` | Readonly runtime list of model types |
| `LanguageIdConcreteModelType` | Alias of `LanguageIdModelType` (non-`auto`) |
| `LanguageIdDetectOptions` | Options for `detectLanguageIdModel` (`modelType?`, `assetName?`, `quantization?`) |
| `LanguageIdDetectResult` | Return of `detectLanguageIdModel()` |
| `LanguageIdentificationInitializeOptions` | Init options for `createLanguageIdentification` (`modelSource`, `customConfig`, `quantization`, `numThreads`, …) |
| `LanguageIdCustomConfig` | `{ encoder, decoder }` `FileSource` paths for custom init |
| `LanguageIdentificationOptions` | Optional `segmentation`, `onProgress`, `onSegment`, `onLanguageChanged`, `targetSegmentBuffer` |
| `LanguageIdentificationResult` | `{ lang, audioDuration, elapsedMs }` |
| `SegmentedLanguageIdentificationResult` | `{ dominantLanguage, distribution, switches, segments, totalSegments, processingTimeMs }` |
| `LanguageIdSegmentEntry` | Per-segment detail: `segmentIndex`, `startTime`, `endTime`, `durationMs`, `lang` |
| `LanguageSwitchEntry` | `{ timestamp, from, to, segmentIndex }` |
| `LanguageIdSegmentEvent` | Per-span callback event (`segmentIndex`, ranges, `lang`) |
| `LanguageChangedEvent` | Language transition (`previousLang`, `currentLang`, `timestamp`, `segmentIndex`) |
| `LanguageIdLabelOptions` | Options for `labelOfflineSegments` (`onProgress`, `onSegment`, `onLanguageChanged`) |
| `LabelOfflineSegmentsResult` | `{ labeledCount, dominantLanguage, distribution, switches }` |
| `LanguageIdentificationEngine` | `identify` (oneshot / segmented / live), `labelOfflineSegments`, `destroy` |
| `DEFAULT_LANGUAGE_ID_SEGMENTATION_POLICY` | Runtime constant — energy silence, `minSegmentMs: 1500` |
| `LanguageIdErrorCode` | Offline/live error code object |
| `OrchestrationProgress` | Shared offline progress payload (`currentSegment`, `totalSegments`, `fraction`, …) |

Live-only types (`LanguageIdentificationLivePipelineOptions`, `LanguageIdentificationPipelineHandle`, `StreamingPipelineCompletion`, `StreamingPipelineStatus`): [language-identification-live.md](language-identification-live.md#types).

### Related buffer types

| Type | Description |
| --- | --- |
| `OfflineAudioBufferIdSource` | Offline audio ref or handle passed to `identify` |
| `OfflineSegmentBufferIdSource` | Offline segment buffer for `targetSegmentBuffer` / `labelOfflineSegments` |

See [audiobuffer-offline.md](audiobuffer-offline.md) · [segmentbuffer-offline.md](segmentbuffer-offline.md).

---

## Error codes

| Error code | Explanation |
| --- | --- |
| `LANGUAGE_ID_NOT_INITIALIZED` | Engine not created / native instance missing. |
| `LANGUAGE_ID_ALREADY_INITIALIZED` | Duplicate init for the same instance path. |
| `LANGUAGE_ID_INVALID_ARGUMENT` | Bad options / buffer kind / missing required fields. |
| `LANGUAGE_ID_AUDIO_BUFFER_NOT_FOUND` | Audio buffer id missing from the registry. |
| `LANGUAGE_ID_AUDIO_BUFFER_EMPTY` | Offline audio has no samples. |
| `LANGUAGE_ID_INIT_ERROR` | Model load / native construct failed. |
| `LANGUAGE_ID_IDENTIFY_FAILED` | Identify / label path failed. |
| `LANGUAGE_ID_DESTROYED` | Call after `destroy()`. |
| `SEGMENT_*` / `FILEIO_*` | Segment buffers / `FileSource` resolution (same as other offline features). |

---

## See also

- [Spoken language identification (live overload)](language-identification-live.md)
- [STT offline — Whisper](stt-offline.md)
- [Segmentation engine](segmentation-engine.md)
- [Pipeline audio buffers — offline](audiobuffer-offline.md)
- [Pipeline segment buffers — offline](segmentbuffer-offline.md)
- [Model detect](model-detect.md)
- [Download manager](download-manager.md)

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK **last-activity ring buffer**. Full details: [native-diagnostics.md](./native-diagnostics.md).
