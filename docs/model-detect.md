# Model detection

## Introduction

Model detection inspects a **model directory** and/or a **release asset name** to determine **which Sherpa feature owns the pack** (`ModelCategory`) and the **concrete model family** (`modelType`, e.g. `whisper`, `vits`, `silero_vad`). Detection is **stateless**: it does not load recognizers, TTS engines, or other runtime weights.

Two APIs exist:

| API | Import | When to use |
| --- | --- | --- |
| **Unified** | `react-native-sherpa-onnx/detect` | Category unknown; catalog / library UX; batch scans (one native call per item in batch) |
| **Feature-specific** | `react-native-sherpa-onnx/stt`, `/tts`, `/vad`, … | You already know the feature; need full detect payloads (`detectedModels`, `paths`, `detectionSources`, required-file validation) |

Unified detection runs the same native domain detectors as the feature APIs, in a **fixed order** (first hit wins). Feature-specific detectors expose richer results documented on each feature page.

## Import path

```ts
import {
  detectModel,
  detectModelsBatch,
  detectModelResultMatchesCategory,
  isQnnModelName,
  resolveFileSourceForDetect,
  type DetectModelInput,
  type DetectModelResult,
} from 'react-native-sherpa-onnx/detect';
```

`react-native-sherpa-onnx/download` still re-exports the unified APIs for backward compatibility; prefer `./detect` for new code.

## Models and paths

| Input | Type | Notes |
| --- | --- | --- |
| Filesystem / bundled tree | `FileSource` from `react-native-sherpa-onnx/fileio` | Resolved to `modelDir` + `assetName` via `resolveFileSourceForDetect` |
| Name-only (no listable dir) | `{ assetName: string; modelDir?: string }` | Heuristics from the asset/folder name; `modelDir` may be `''` |
| Catalog category filter | `detectModelResultMatchesCategory` | Maps unified results to `ModelCategory` slices (incl. QNN) |

See also [model-setup.md](model-setup.md), [fileio.md](fileio.md), [download-manager.md](download-manager.md).

## When to use unified vs feature-specific detection

| Scenario | Recommended API |
| --- | --- |
| Model library row: “what is this download?” | `detectModel` |
| Scan many repos/folders (HF author test, catalog hints) | `detectModelsBatch` |
| Filter unified result for download category `Stt` vs `Qnn` | `detectModelResultMatchesCategory` |
| Before `createSTT` / `createStreamingSTT` with required-file checks | `detectSttModel` — [stt-offline.md](stt-offline.md#detection-and-factory) |
| Before `createTTS` with lexicon / speaker metadata | `detectTtsModel` — [tts-offline.md](tts-offline.md#detectttsmodelsource-options) |
| VAD / punctuation / enhancement / alignment init | `detectVadModel`, `detectPunctuationModel`, `detectEnhancementModel`, `detectAlignmentModel` on the matching feature package |

Unified `detectModel` returns a **compact** result (`category`, `modelType`, `languages`, `quantization`, `sizeTier`, `isStreaming`, optional `supportsQnn`). It does **not** replace feature detect APIs when you need `detectedModels`, per-family `paths`, or `success` / `error` from required-file validation.

## Quick start

### 1) Detect category from a downloaded folder

```ts
import { detectModel } from 'react-native-sherpa-onnx/detect';
import { ModelCategory } from 'react-native-sherpa-onnx/download';

const result = await detectModel({
  kind: 'fs',
  path: '/absolute/path/to/extracted-model-dir',
});

if (!result.matched) {
  console.log('No Sherpa category matched');
} else {
  console.log(result.category, result.modelType, result.languages);
  // e.g. ModelCategory.Stt, 'zipformer2_ctc', ['en']
}
```

### 2) Name-only detect (asset id before files exist)

```ts
import { detectModel } from 'react-native-sherpa-onnx/detect';

const result = await detectModel({
  assetName: 'sherpa-onnx-streaming-zipformer-en-2023-06-26',
});
// Uses native name heuristics; modelDir defaults to ''.
```

### 3) Batch detect for a model library

```ts
import {
  detectModelsBatch,
  detectModelResultMatchesCategory,
} from 'react-native-sherpa-onnx/detect';
import { ModelCategory } from 'react-native-sherpa-onnx/download';

const inputs = [
  { kind: 'fs' as const, path: '/data/models/pack-a' },
  { assetName: 'vits-piper-en_US-lessac-medium' },
];

const results = await detectModelsBatch(inputs, { concurrency: 8 });

results.forEach((r, i) => {
  if (r.matched && detectModelResultMatchesCategory(ModelCategory.Stt, r)) {
    console.log('STT pack', i, r.modelType);
  }
});
```

### 4) Resolve `FileSource`, then call feature-specific detect

```ts
import { resolveFileSourceForDetect } from 'react-native-sherpa-onnx/detect';
import { detectSttModel } from 'react-native-sherpa-onnx/stt';

const source = { kind: 'app' as const, base: 'apkAsset' as const, path: 'models/whisper-tiny' };
const { modelDir, assetName } = await resolveFileSourceForDetect(source);
// Same resolution path unified detect uses internally.

const det = await detectSttModel(source);
if (!det.success) throw new Error(det.error ?? 'STT detect failed');
```

## Unified detector order (first hit wins)

Native unified detection (`DetectModel` / `DetectModelsBatch`) tries domains in this order:

1. **TTS**
2. **STT**
3. **VAD**
4. **Punctuation**
5. **Enhancement**
6. **Alignment**

A domain counts as a hit when native detection succeeds and `modelType !== 'unknown'`. If nothing matches, `detectModel` returns `{ matched: false }` (no thrown error).

Implications:

- A directory that could be misread by an earlier detector is classified by the **first** matching domain. This matches catalog/library use cases where each folder is intended for one feature.
- When you **know** the target feature, prefer that feature’s `detect*Model` so validation and `paths` match engine init exactly.

## QNN and `ModelCategory`

QNN release packs are **STT** models with a specific naming convention. Unified detect sets:

- `category: ModelCategory.Stt`
- `supportsQnn: true` when the asset name matches the QNN binary pattern (see `isQnnModelName`)

Use `detectModelResultMatchesCategory(ModelCategory.Qnn, result)` to treat QNN as its own catalog slice, or `ModelCategory.Stt` to exclude QNN-named packs from the regular STT list.

## Input resolution

### `DetectModelInput`

```ts
type DetectModelInput = FileSource | { assetName: string; modelDir?: string };
```

### `resolveFileSourceForDetect(source)`

Maps `FileSource` (`fs` / `app` / `pad`) to native inputs. This lives on **`detect`**, not `fileio`: `fileio` defines source types and copy/save/share; engines need a directory path and/or basename for heuristics.

```ts
function resolveFileSourceForDetect(source: FileSource): Promise<ResolvedDetectInput>;

type ResolvedDetectInput = {
  modelDir: string;   // absolute path, or '' for name-only
  assetName: string | null;
};
```

`resolveFileSourceForModelInit` uses the same mapping for `createSTT`, `createTTS`, etc.

**Errors:** invalid or unsafe paths reject with `FILEIO_*` **before** native detection (same as feature `detect*Model` when passed a `FileSource`).

**`assetName` derivation:** last path segment with common archive suffixes stripped (`.tar.bz2`, `.zip`, …). Optional explicit `assetName` on feature detect options overrides catalog hints when passed through to native.

## Data model

### `DetectModelResult`

```ts
type DetectModelResult = { matched: false } | DetectModelMatchedResult;

type DetectModelMatchedResult = {
  matched: true;
  category: ModelCategory;
  modelType: string;
  languages: string[];       // ISO 639-1 hints via model-languages helpers
  quantization: Quantization;
  sizeTier: SizeTier;
  isStreaming: boolean;
  isHardwareSpecificUnsupported?: boolean;
  supportsQnn?: boolean;    // STT + QNN naming convention
};
```

| Field | Meaning |
| --- | --- |
| `matched` | `false` = no domain hit; unified API does not throw |
| `category` | `ModelCategory` enum value for routing downloads / UI |
| `modelType` | Family string (`whisper`, `vits`, `silero_vad`, …) |
| `languages` | Public language hints normalized in JS |
| `isStreaming` | Native streaming/offline hint for the matched family |
| `isHardwareSpecificUnsupported` | STT packs that need special hardware paths |
| `supportsQnn` | STT hit that also matches QNN release naming |

## API reference

### `detectModel(input)`

```ts
function detectModel(input: DetectModelInput): Promise<DetectModelResult>;
```

Single native bridge call after input resolution.

```ts
const r = await detectModel({ kind: 'fs', path: '/path/to/model' });
if (r.matched) {
  console.log(r.category, r.modelType);
}
```

### `detectModelsBatch(inputs, options?)`

```ts
function detectModelsBatch(
  inputs: readonly DetectModelInput[],
  options?: { concurrency?: number }
): Promise<DetectModelResult[]>;
```

- Default `concurrency`: `8`
- Each batch chunk uses one native `detectModelsBatch` call (not N sequential `detectModel` calls)
- Result order matches `inputs`

```ts
const rows = await detectModelsBatch(
  [{ assetName: 'foo' }, { assetName: 'bar' }],
  { concurrency: 4 }
);
```

### `detectModelResultMatchesCategory(category, result)`

```ts
function detectModelResultMatchesCategory(
  category: ModelCategory,
  result: DetectModelMatchedResult
): boolean;
```

Only call when `result.matched === true`. Special cases:

| `category` | Matches when |
| --- | --- |
| `ModelCategory.Qnn` | `category === Stt` && `supportsQnn === true` |
| `ModelCategory.Stt` | `category === Stt` && `supportsQnn !== true` |
| Other | `result.category === category` |

### `isQnnModelName(name)`

```ts
function isQnnModelName(name: string): boolean;
```

Shared naming check for QNN binary releases (also used when building `supportsQnn` on unified STT hits).

## Custom path validation

For **`initMode: 'custom'`** (and early app-side checks), use the unified native validation layer backed by C++ `validate-*.cpp` tables (STT, TTS, VAD, Enhancement, Punctuation, Alignment):

```ts
import {
  getCustomModelPathRequirements,
  validateCustomModelPaths,
} from 'react-native-sherpa-onnx/detect';
import { ModelCategory } from 'react-native-sherpa-onnx/download';

// Schema for forms / slot pickers (required vs optional keys)
const schema = await getCustomModelPathRequirements(ModelCategory.Stt, 'paraformer');

// Runtime check on resolved absolute paths (Record<string, string>)
const result = await validateCustomModelPaths(ModelCategory.Tts, 'vits', {
  ttsModel: '/path/model.onnx',
  tokens: '/path/tokens.txt',
});
if (!result.ok) {
  console.warn(result.error, result.missingRequired);
}
```

Categories match unified detect literals: `stt`, `stt_streaming`, `tts`, `vad`, `enhancement`, `punctuation`, `alignment`.

- **`stt_streaming`** — online/streaming STT custom init (`createStreamingSTT` with `initMode: 'custom'`). Path keys differ from offline `stt`: transducer uses `encoder`/`decoder`/`joiner`/`tokens`; CTC streaming types use `model`/`tokens` (not offline `ctcModel`).

- **`getCustomModelPathRequirements`** — read-only schema; paraformer includes optional offline/streaming keys (`paraformerModel`, `encoder`, `decoder`) with `tokens` required.
- **`validateCustomModelPaths`** — enforces non-empty paths and feature-specific rules (e.g. paraformer OR-layout, `moonshine` vs `moonshine_v2`).

TypeScript discriminated unions in `src/stt/customConfig.ts`, `src/tts/customConfig.ts`, `src/vad/customConfig.ts`, and `src/enhancement/customConfig.ts` remain compile-time helpers; **runtime truth is native**.

## Feature-specific detection APIs

Use these when initializing engines or when you need validation details. Each page documents required files, `paths`, and `detectionSources`.

| Feature | Function | Guide |
| --- | --- | --- |
| STT (offline / streaming) | `detectSttModel` | [stt-offline.md — Detection](stt-offline.md#detection-and-factory), [stt-streaming.md](stt-streaming.md#detection-and-initialization) |
| TTS | `detectTtsModel` | [tts-offline.md — `detectTtsModel`](tts-offline.md#detectttsmodelsource-options) |
| VAD | `detectVadModel` | [vad-streaming.md](vad-streaming.md#model-detection) |
| Punctuation | `detectPunctuationModel` | [punctuation-offline.md](punctuation-offline.md#model-detection), [punctuation-streaming.md](punctuation-streaming.md#model-detection) |
| Enhancement | `detectEnhancementModel` | [enhancement-offline.md](enhancement-offline.md#model-detection) |
| Alignment | `detectAlignmentModel` | [alignment-offline.md](alignment-offline.md#model-detection) |

## Download manager and catalogs

The download module uses unified batch detection internally for catalog hints and Hugging Face author validation. App code that builds custom libraries should use the same `detect` entry point rather than calling multiple `detect*Model` APIs in sequence (fewer bridge round-trips, consistent category order).

See [download-manager.md](download-manager.md) and [model-languages.md](model-languages.md) for category enums and language display.

## Related docs

- [model-setup.md](model-setup.md) — bundled assets, discovery
- [model-delivery-pad-odr.md](model-delivery-pad-odr.md) — PAD & ODR (install-time, on-demand)
- [memory-and-models.md](memory-and-models.md) — detect before heavy engine init
- [execution-providers.md](execution-providers.md) — QNN provider setup (after you know the pack is QNN-capable)
- [fileio.md](fileio.md) — `FileSource` shapes
