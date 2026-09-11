# Streaming Keyword Spotting (KWS)

## Introduction

On-device **open-vocabulary keyword spotting** (wake-word / customized keywords) with a **pipeline-first** API. Each detected keyword commits a text segment with the keyword label to the output buffer.

Import path: **`react-native-sherpa-onnx/kws`**.

**Naming in this doc:** **`engine`** = `KeywordSpottingEngine`; **`pipeline`** = handle from `engine.spot(...)`.

KWS is **streaming-only** in this SDK:

- There is **no** offline/batch `spot(OfflineAudioBuffer)` API.
- Use dedicated **`kws-models`** packs (encoder + decoder + joiner + `tokens.txt` + `keywords.txt`). Do **not** point KWS at arbitrary streaming STT zipformer packs.
- Hits are keyword labels, not a full transcript. For continuous speech recognition see [Streaming STT](stt-streaming.md).
- Live → offline audio transfer is for **retention** (archive, later STT/SID) only — never `spot` an offline clip.

Upstream overview: [sherpa-onnx Keyword spotting](https://k2-fsa.github.io/sherpa/onnx/kws/index.html).

## Streaming pipeline system

`spot` starts a **native worker** that drains **`LiveAudioBuffer`** frames, runs the online KeywordSpotter decode loop, and **commits** each hit to **`LiveTextBuffer`**. After a hit the worker **`reset`s** the online stream (upstream requirement). Control uses the returned **`StreamingPipelineHandle`** (`stop` / `flush` / `reset` / `getStatus` / `completed`) — see **[Streaming pipelines — shared lifecycle](streaming-pipelines-overview.md)**.

Mic and file paths share the **same** API: feed the live ring with `startMicToLiveAudioBuffer` or `ingestFileToLiveAudioBuffer`.

## Quick start

### 1) Mic wake-word session

```ts
import {
  createKeywordSpotting,
  detectKwsModel,
} from 'react-native-sherpa-onnx/kws';
import {
  createEmptyLiveAudioBuffer,
  finalizeLiveAudioBuffer,
  releasePipelineAudioBuffer,
  startMicToLiveAudioBuffer,
  stopMicToLiveAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createLiveTextBuffer,
  releasePipelineTextBuffer,
} from 'react-native-sherpa-onnx/textbuffer';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';

const source: FileSource = {
  kind: 'fs',
  path: '/absolute/path/to/sherpa-onnx-kws-zipformer-…',
};

const det = await detectKwsModel(source);
if (!det.success) throw new Error(det.error ?? 'detectKwsModel failed');
if (!det.isStreaming) {
  throw new Error('Detected model is not a streaming KWS pack');
}

const engine = await createKeywordSpotting({
  modelSource: source,
  // Optional: replace pack keywords.txt
  // keywordsPath: '/absolute/path/to/my-keywords.txt',
  keywordsScore: 1.5,
  keywordsThreshold: 0.25,
  numTrailingBlanks: 2,
});

const audioIn = await createEmptyLiveAudioBuffer({
  sampleRate: 16000,
  channelCount: 1,
});

// LiveTextBuffer spooling defaults to on/auto (same as STT). Keep that if you
// later need fullIfSpooled / offline transfer of hit history. For wake
// callbacks only, prefer spooling off to avoid disk I/O on each hit:
const textOut = await createLiveTextBuffer({
  spooling: { mode: 'off' },
  onSegment: (e) => {
    console.log('[kws segment]', e.segment.text, e.segment.meta);
  },
});

const pipeline = await engine.spot(audioIn, textOut, {
  // Native default chunkSize is 1600 (~100ms @ 16 kHz)
  onKeyword: (e) => {
    console.log('[kws hit]', e.keyword, e.segmentIndex, e.startTime);
  },
});

await startMicToLiveAudioBuffer(audioIn);

// … wait for wake words …

await stopMicToLiveAudioBuffer();
await finalizeLiveAudioBuffer(audioIn);
await pipeline.flush();
await pipeline.completed;

await engine.destroy();
await releasePipelineTextBuffer(textOut);
await releasePipelineAudioBuffer(audioIn);
```

### 2) File / wav via the same streaming API

```ts
import { ingestFileToLiveAudioBuffer } from 'react-native-sherpa-onnx/audiobuffer';

const pipeline = await engine.spot(audioIn, textOut, {
  onKeyword: (e) => console.log(e.keyword),
});

await ingestFileToLiveAudioBuffer(audioIn, {
  kind: 'fs',
  path: '/absolute/path/to/sample.wav',
});
await finalizeLiveAudioBuffer(audioIn);
await pipeline.flush();
await pipeline.completed;
```

## Keywords UX

Open vocabulary means you customize **which phrases** fire without retraining weights. Phrases must still be expressible in the pack's **token inventory** (`tokens.txt` / BPE / pinyin units).

### `keywords.txt` line format

Each line is one keyword. Space-separated **tokens**, then optional extras (no space after `:` / `#` / `@`):

```
▁HE LL O ▁WORLD :1.5 #0.35
▁HI ▁GO O G LE :1.0 #0.25
▁HE Y ▁S I RI
小 爱 同 学 :2.0 #0.6 @小爱同学
```

| Suffix | Meaning |
| --- | --- |
| `:score` | Per-keyword boosting score (larger → easier to trigger) |
| `#threshold` | Per-keyword trigger threshold in `[0, 1]` (lower → easier to trigger) |
| `@label` | Human-readable label returned on hit (required for some pinyin token types; **no spaces** in `@label` — use `_`) |

Pack defaults ship a `keywords.txt` next to the ONNX files. Override **per session** with `spot({ keywords })` (safe on OOV — Promise rejection). Optional `keywordsPath` at create is also applied via `createStream` (not via upstream `KeywordSpotter` construction — that path calls `_Exit` on encode failure; see [KNOWN_ISSUES](KNOWN_ISSUES.md)).

### Generating tokens with `text2token`

Use upstream tooling against the pack's `tokens.txt` (and BPE / lexicon when required):

```sh
# After: pip install sherpa-onnx
sherpa-onnx-cli text2token \
  --tokens /path/to/tokens.txt \
  --tokens-type bpe \
  --bpe-model /path/to/bpe.model \
  phrases.txt keywords.txt
```

`--tokens-type` examples: `bpe`, `cjkchar`, `cjkchar+bpe`, `fpinyin`, `ppinyin`, `phone+ppinyin`. Input lines may already carry `:score`, `#threshold`, and `@label`; extras are preserved in the output. Full help and examples: [sherpa-onnx KWS — Keywords file](https://k2-fsa.github.io/sherpa/onnx/kws/index.html).

### Init file vs per-session override (reload without destroy)

| Goal | How | Engine lifecycle |
| --- | --- | --- |
| Default keywords from the pack | Omit overrides; detect uses `<modelDir>/keywords.txt` | — |
| Different keywords file at engine create | `createKeywordSpotting({ keywordsPath })` — body applied on each `spot` via `createStream` (pack `keywords.txt` still used for spotter construction) | Create once; path must exist on disk; tokens must match pack `tokens.txt` |
| New phrases for **one** `spot` session | `spot(..., { keywords })` → native `createStream(keywords)` | **Same engine** — no destroy |
| Change phrases **mid** listening | `await pipeline.stop()` then `spot(..., { keywords: next })` again | Same engine |
| Change `keywordsScore` / `keywordsThreshold` / `numTrailingBlanks` | `await engine.destroy()` then `createKeywordSpotting` again | Re-init required (init-time config) |

`spot({ keywords })` accepts the **same textual format as a `keywords.txt` body** (one or more lines). Empty / omit → use the keywords file from engine init.

There is **no** separate `engine.reloadKeywords()` API in MVP; the patterns above are the supported UX.

## Tuning

| Option | Where | Default | Notes |
| --- | --- | --- | --- |
| `keywordsScore` | init | `1.5` | Global boost when per-line `:score` is absent |
| `keywordsThreshold` | init | `0.25` | Global threshold when per-line `#threshold` is absent |
| `numTrailingBlanks` | init | `2` | Lower → sooner fire, more false triggers |
| `maxActivePaths` | init | `4` | Beam width |
| `chunkSize` | `spot` | **1600** (~100 ms @ 16 kHz) | Samples per drain from the live ring; smaller → lower wake latency, more wakeups |

## LiveTextBuffer spooling

`textOut` uses normal LiveTextBuffer defaults (**spooling on/auto**), same as STT/VAD. KWS does not override that.

- Keep the default when you want hit history via spool replay / `fullIfSpooled` transfer later.
- For wake-word **callbacks only**, create the buffer with `spooling: { mode: 'off' }` to avoid disk I/O on every hit.

See [textbuffer-streaming.md](textbuffer-streaming.md).

## Buffer matrix

| Role | Type | Notes |
| --- | --- | --- |
| **Audio in** | [`LiveAudioBuffer`](audiobuffer-streaming.md) | Continuous PCM the native worker reads |
| **Text out** | [`LiveTextBuffer`](textbuffer-streaming.md) | One committed text segment per keyword hit |
| **Engine** | `KeywordSpottingEngine` via `createKeywordSpotting` | `spot(audioIn, textOut)` returns pipeline handle |
| **Pipeline handle** | `StreamingPipelineHandle` | `stop` / `flush` / `reset` / `getStatus` / `completed` |

## Models

| `modelType` | Required files | Custom-init keys |
| --- | --- | --- |
| `transducer` | `encoder*.onnx`, `decoder*.onnx`, `joiner*.onnx`, `tokens.txt`, `keywords.txt` | `encoder`, `decoder`, `joiner`, `tokens`, `keywords` |

Validate category: **`kws`**. Online zipformer2-style KWS packs (folder name with `kws` or root `keywords.txt`). Detection: [model-detect.md](model-detect.md) · downloads: [download-manager.md](download-manager.md) (`ModelCategory.Kws`).

## API reference

All signatures below are exported from `react-native-sherpa-onnx/kws`.

### `detectKwsModel(source, options?)`

File-based detection **without** initializing the engine. Prefer when you know the folder is a KWS pack. Unified `detectModel` also claims **`kws` before `stt`** so keyword packs are not stolen as ASR — see [model-detect.md](model-detect.md#unified-detector-order).

```ts
function detectKwsModel(
  source: FileSource,
  options?: {
    assetName?: string;
    modelType?: 'auto' | 'transducer';
    quantization?: QuantizationPreference;
  }
): Promise<KwsDetectModelResult>;
```

```ts
const det = await detectKwsModel({
  kind: 'fs',
  path: '/absolute/path/to/kws-pack',
});
console.log(det.success, det.isStreaming, det.paths?.keywords);
```

### `createKeywordSpotting(options)` / `createStreamingKWS(options)`

Creates a `KeywordSpottingEngine`. Init modes: **`auto`** (default — `modelSource` + optional `quantization`) or **`custom`** (`initMode: 'custom'` + `modelType: 'transducer'` + `customConfig`). Shared tuning: `keywordsScore`, `keywordsThreshold`, `numTrailingBlanks`, `maxActivePaths`, `numThreads`, `provider`, `debug`.

`createStreamingKWS` is an alias for `createKeywordSpotting`.

```ts
function createKeywordSpotting(
  options: KeywordSpottingInitOptions
): Promise<KeywordSpottingEngine>;
```

```ts
const engine = await createKeywordSpotting({
  modelSource: { kind: 'fs', path: '/absolute/path/to/kws-pack' },
  keywordsPath: '/absolute/path/to/keywords.txt', // optional
  keywordsScore: 1.5,
  keywordsThreshold: 0.25,
  numTrailingBlanks: 2,
  maxActivePaths: 4,
});
```

### `engine.spot(audioIn, textOut, options?)`

Starts real streaming keyword spotting. Reads continuously from `audioIn`, commits hits to `textOut`, and returns a shared streaming pipeline handle (`stop` / `flush` / `reset` / `completed`). Only **one** active pipeline per engine at a time.

```ts
spot(
  audioIn: LiveAudioBufferIdSource,
  textOut: LiveTextBufferIdSource,
  options?: KeywordSpottingPipelineOptions
): Promise<StreamingPipelineHandle & { instanceId: string }>;
```

```ts
const pipeline = await engine.spot(audioIn, textOut, {
  chunkSize: 1600,
  keywords: '▁HE Y ▁S I RI :1.5 #0.25',
  onKeyword: (e) => console.log(e.keyword),
});
```

### `engine.destroy()`

Stops any active pipeline and unloads the native KeywordSpotter. Idempotent.

```ts
destroy(): Promise<void>;
```

```ts
await engine.destroy();
```

---

## Pipeline composition

### Typical upstream

| Source / feature | Buffer or handle | Notes |
| --- | --- | --- |
| Mic / file ingest | `LiveAudioBuffer` (`live_*`) | Continuous audio for `spot(...)`. |
| Keyword list | Init / `createKeywordSpotting` options | Labels become committed LiveText. |

### Typical downstream

| Destination / feature | Buffer or handle | Notes |
| --- | --- | --- |
| Keyword events | `LiveTextBuffer` (`txt_live_*`) | Commits with `meta.source: 'kws_stream'`. |
| App wake / routing | `onKeyword` / `onSegment` | Prefer callbacks over polling. |

```mermaid
flowchart LR
  A[LiveAudioBuffer] --> B["createKeywordSpotting().spot"]
  B --> C[LiveTextBuffer]
  C --> D[onKeyword / UI]
```

Shared lifecycle: [streaming-pipelines-overview.md](streaming-pipelines-overview.md).

## JS Events

| Callback | Payload | Fires when | Notes |
| --- | --- | --- | --- |
| `onKeyword` | `KeywordDetection` | keyword detected in audio stream | convenience over `onSegment`; fires when `meta.source === 'kws_stream'` |
| `onSegment` | `LiveTextBufferSegmentEvent` | committed text segment on output buffer | raw live-text commit; filter `meta.source` if other writers share the buffer |

Prefer **callbacks**, not polling. `onKeyword` is convenience over the same commit as `onSegment` — use either or both.

Committed segment text is the keyword **label**. `KeywordDetection` also exposes `tokens`, `timestamps`, and optional `startTime` (usually present on **iOS** via sherpa C-API `start_time`; usually **omitted on Android** because the Kotlin `KeywordSpotterResult` has no start-time field).

```ts
const textOut = await createLiveTextBuffer({
  spooling: { mode: 'off' },
  onSegment: (e) => {
    if (e.segment.meta?.source !== 'kws_stream') return;
    console.log('[onSegment]', e.segment.text, e.segment.meta);
  },
});

const pipeline = await engine.spot(audioIn, textOut, {
  onKeyword: (e) => {
    console.log('[onKeyword]', e.keyword, e.segmentIndex, e.startTime);
  },
});
```

---

## Types

### Core KWS types (`react-native-sherpa-onnx/kws`)

| Type | Description |
| --- | --- |
| `KwsConcreteModelType` | `'transducer'` |
| `KwsDetectOptions` | Options for `detectKwsModel` (`assetName?`, `modelType?`, `quantization?`) |
| `KwsDetectModelResult` | Return of `detectKwsModel()` (`success`, `error?`, `isStreaming`, `paths`, `quantization`, …) |
| `KeywordSpottingInitOptions` | Discriminated union: `KeywordSpottingAutoInitializeOptions \| KeywordSpottingCustomInitializeOptions` |
| `KeywordSpottingInitOptionsShared` | Shared fields: `keywordsPath?`, `keywordsScore?`, `keywordsThreshold?`, `numTrailingBlanks?`, `maxActivePaths?`, `numThreads?`, `provider?`, `debug?` |
| `KeywordSpottingAutoInitializeOptions` | Auto mode: `modelSource`, optional `quantization` |
| `KeywordSpottingCustomInitializeOptions` | Custom mode: `initMode: 'custom'`, `modelType: 'transducer'`, `customConfig: KwsCustomConfig` |
| `KeywordSpottingPipelineOptions` | `chunkSize?`, `keywords?`, `onKeyword?` |
| `KeywordDetection` | `{ keyword: string; tokens: string[]; timestamps: number[]; startTime?: number }` |
| `KeywordSpottingEngine` | `spot`, `destroy`, readonly `instanceId` |
| `KwsCustomConfig` | `{ encoder, decoder, joiner, tokens, keywords }` — all `FileSource` |
| `KwsCustomPathKey` | `'encoder' \| 'decoder' \| 'joiner' \| 'tokens' \| 'keywords'` |
| `KwsErrorCode` | `{ INVALID_ARGUMENT: 'KWS_INVALID_ARGUMENT' }` |
| `KeywordSpottingDetectedPaths` | Paths resolved by native detection (encoder, decoder, joiner, tokens, keywords) |

### Related buffer types

| Type | Description |
| --- | --- |
| `LiveAudioBufferIdSource` | Live audio ref or handle passed to `spot` |
| `LiveTextBufferIdSource` | Live text buffer ref or handle for keyword hits |
| `StreamingPipelineHandle` | Shared pipeline handle (`stop`, `flush`, `reset`, `getStatus`, `completed`) |

See [audiobuffer-streaming.md](audiobuffer-streaming.md) · [textbuffer-streaming.md](textbuffer-streaming.md) · [streaming-pipelines-overview.md](streaming-pipelines-overview.md).

---

## Error codes

| Code | Typical reason |
| --- | --- |
| `KWS_INVALID_ARGUMENT` | Custom config / keywords override malformed or not a `FileSource` |
| `AUDIO_BUFFER_NOT_FOUND` | Input live audio buffer id is invalid or released |
| `TEXT_BUFFER_NOT_FOUND` | Output live text buffer id is invalid or released |
| `PIPELINE_NOT_FOUND` | Invalid or already-stopped pipeline handle id |
| `STREAMING_PIPELINE_ERROR` | Fatal pipeline worker exception |

Additional `FILEIO_*` / detect errors can occur during model path resolution before native init.

## Troubleshooting

| Symptom | Likely cause | What to try |
| --- | --- | --- |
| Detect fails / "not KWS" | STT zipformer pack without KWS layout / `keywords.txt` | Use a `kws-models` release asset; prefer `detectKwsModel` |
| Unified detect returns STT | Pack lacks KWS cues | Ensure folder name contains `kws` or root `keywords.txt`; KWS runs **before** STT in unified order when it matches |
| No hits | Threshold / score / trailing blanks too strict; wrong tokens | Lower `#threshold` / `keywordsThreshold`; raise `:score`; lower `numTrailingBlanks`; regenerate tokens with the pack's `tokens.txt` |
| Slow wake | Large `chunkSize` | Use default `1600` or smaller |
| Invalid override | Empty / wrong `spot({ keywords })` string | Pass `keywords.txt`-format lines; omit to use init file |
| Unexpected disk I/O | LiveTextBuffer spooling on | `createLiveTextBuffer({ spooling: { mode: 'off' } })` for callback-only |

## Use case examples

<details>
<summary>Wake-word hits while the mic is still open</summary>

`onKeyword` fires as soon as a hit is decoded — you can react in the UI without awaiting `pipeline.completed`.

```ts
import { createKeywordSpotting } from 'react-native-sherpa-onnx/kws';
import {
  createEmptyLiveAudioBuffer,
  startMicToLiveAudioBuffer,
  finalizeLiveAudioBuffer,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import { createLiveTextBuffer, releasePipelineTextBuffer } from 'react-native-sherpa-onnx/textbuffer';

const engine = await createKeywordSpotting({
  modelSource: { kind: 'fs', path: '/path/to/kws-models' },
});
const audioIn = await createEmptyLiveAudioBuffer({ sampleRate: 16000, channelCount: 1 });
const textOut = await createLiveTextBuffer({ maxSegments: 256, spooling: { mode: 'off' } });

const pipeline = await engine.spot(audioIn, textOut, {
  chunkSize: 1600,
  onKeyword: (hit) => console.log('wake:', hit.keyword, hit.timestamps),
});
const mic = await startMicToLiveAudioBuffer(audioIn);

// Hits can arrive here while mic is still running
await new Promise((r) => setTimeout(r, 30_000));

await mic.stop();
await finalizeLiveAudioBuffer(audioIn);
await pipeline.flush();
await pipeline.completed;

await engine.destroy();
await releasePipelineTextBuffer(textOut);
await releasePipelineAudioBuffer(audioIn);
```

</details>

<details>
<summary>File ingest with live keyword HUD updates</summary>

Start spotting, then ingest a WAV. Keyword callbacks update the HUD while ingest and decode overlap; await completion only after ingest finishes.

```ts
import { createKeywordSpotting } from 'react-native-sherpa-onnx/kws';
import {
  createEmptyLiveAudioBuffer,
  ingestFileToLiveAudioBuffer,
  finalizeLiveAudioBuffer,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import { createLiveTextBuffer, releasePipelineTextBuffer } from 'react-native-sherpa-onnx/textbuffer';

const engine = await createKeywordSpotting({
  modelSource: { kind: 'fs', path: '/path/to/kws-models' },
});
const audioIn = await createEmptyLiveAudioBuffer({ sampleRate: 16000, channelCount: 1 });
const hits = await createLiveTextBuffer({
  maxSegments: 128,
  onSegment: (e) => console.log('hit segment:', e.segment.text),
});

const pipeline = await engine.spot(audioIn, hits, {
  onKeyword: (h) => console.log('HUD', h.keyword),
});
const ingest = await ingestFileToLiveAudioBuffer(audioIn, { kind: 'fs', path: '/path/to/utterance.wav' });

await ingest.done;
await finalizeLiveAudioBuffer(audioIn);
await pipeline.flush();
await pipeline.completed;

await engine.destroy();
await releasePipelineTextBuffer(hits);
await releasePipelineAudioBuffer(audioIn);
```

</details>

<details>
<summary>Graceful stop: finalize audio, then await `completed`</summary>

Prefer finalize + flush over an abrupt `stop` when you want the last buffered frames scored for keywords.

```ts
await mic.stop();
await finalizeLiveAudioBuffer(audioIn);
await pipeline.flush();
const completion = await pipeline.completed;
console.log('chunks', completion.chunksProcessed, 'hits written', completion.unitsWritten);
await engine.destroy();
```

</details>

## See also

- Example app: **Keyword Spotting** screen (`example/src/screens/kws/`) — developer lab for pack init, keywords textarea / `keywordsPath`, mic + file ingest, hit HUD, unload-while-running
- [Streaming pipelines — shared lifecycle](streaming-pipelines-overview.md)
- [Live audio buffers](audiobuffer-streaming.md) — mic, ingest, finalize
- [Live text buffers](textbuffer-streaming.md) — segments, spooling
- [Model setup](model-setup.md) — `FileSource`, folder layouts
- [Model detection](model-detect.md) — `detectKwsModel`, unified order
- [Download manager](download-manager.md) — `ModelCategory.Kws` → `kws-models`
- [Streaming STT](stt-streaming.md) — full transcription (different feature)
- Upstream: [Keyword spotting](https://k2-fsa.github.io/sherpa/onnx/kws/index.html) · [Pretrained KWS models](https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/index.html)

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK **last-activity ring buffer** (enabled by default when the native library loads). Full details: [native-diagnostics.md](./native-diagnostics.md) — Android log tag `SherpaNativeDiag`; iOS subsystem `com.sherpaonnx.diag`. Optional JS: `getNativeDiagnosticSnapshot` / `configureNativeDiagnostics` from `react-native-sherpa-onnx/diagnostics`.
