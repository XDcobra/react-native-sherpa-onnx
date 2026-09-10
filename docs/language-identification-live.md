# Spoken language identification (live overload)

> **Live overload** — not a streaming SLID model.
>
> This guide uses the **same offline** Whisper multilingual weights as [language-identification-offline.md](language-identification-offline.md). Live audio is sliced by a mandatory **speech segmentation policy**; each committed utterance is identified **natively** inside an `OfflineLivePipelineWorker`. There is **no** separate online/streaming spoken-language-ID model in sherpa-onnx.
>
> Contrast with features that have a **true streaming** engine (e.g. [stt-streaming.md](stt-streaming.md), [vad-streaming.md](vad-streaming.md), [enhancement-streaming.md](enhancement-streaming.md) via `createStreaming*`).

## Introduction

On-device **language tagging** over a live audio stream. SLID owns speech segmentation; a native live worker identifies each committed utterance, commits the ISO language code to a live text Out buffer, and optionally appends labeled speech segments (`payload.source: 'languageId'`).

| Role | Type | Notes |
| --- | --- | --- |
| **Audio in** | [`LiveAudioBuffer`](audiobuffer-streaming.md) | Mic / file ingest |
| **Text out** | [`LiveTextBuffer`](textbuffer-streaming.md) | Required — committed language tags |
| **Segments out (optional)** | [`LiveSegmentBuffer`](segmentbuffer-streaming.md) | `payload.source: 'languageId'`, `lang` |
| **Engine** | Same `LanguageIdentificationEngine` as offline | `identify(liveAudio, liveText, options)` |
| **Pipeline handle** | `LanguageIdentificationPipelineHandle` | `stop` / `flush` / `reset` / `getStatus` / `completed` |

Import path: **`react-native-sherpa-onnx/language-identification`**.

Factory / detect / models: [language-identification-offline.md](language-identification-offline.md#api-reference).

## Quick start

```ts
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

// Assume `slid` from createLanguageIdentification (see offline doc).

const audioIn = await createEmptyLiveAudioBuffer({
  sampleRate: 16000,
  channelCount: 1,
});
const textOut = await createLiveTextBuffer();

const pipeline = await slid.identify(audioIn, textOut, {
  segmentation: {
    mode: 'auto',
    policy: {
      evaluator: 'speech_energy_silence',
      silenceThresholdMs: 500,
      energyThresholdDb: -40,
      minSegmentMs: 1500, // spans shorter than ~1.5s are skipped
      maxSegmentMs: 25000,
      hangoverMs: 300,
    },
  },
  onSegment: (e) => console.log('#', e.segmentIndex, e.lang, e.durationMs),
  onLanguageChanged: (e) =>
    console.log(e.previousLang, '→', e.currentLang, '@', e.timestamp),
});

await startMicToLiveAudioBuffer(audioIn);
// … speak …
await stopMicToLiveAudioBuffer();
await finalizeLiveAudioBuffer(audioIn);
await pipeline.completed; // reason: 'completed'

await releasePipelineTextBuffer(textOut);
await releasePipelineAudioBuffer(audioIn);
```

`finalizeLiveAudioBuffer(audioIn)` drains remaining spans and resolves `completed`. Prefer that over an early `stop()` when the session ends naturally.

## Buffer matrix

| | Offline | Live overload |
| --- | --- | --- |
| **Audio in** | `OfflineAudioBuffer` | `LiveAudioBuffer` |
| **Text out** | — | `LiveTextBuffer` (**required**) |
| **Segments out** | optional offline `targetSegmentBuffer` | optional live `targetSegmentBuffer` |
| **Return** | result object | `LanguageIdentificationPipelineHandle` |

Mixed live/offline arguments throw `LANGUAGE_ID_INVALID_ARGUMENT`.

## Mandatory segmentation

`options.segmentation.policy` is **required** (`LIVE_OFFLINE_SEGMENTATION_REQUIRED` if missing or `mode !== 'auto'`).

| Evaluator | Live overload | Notes |
| --- | --- | --- |
| `speech_energy_silence` | ✅ | Default via `DEFAULT_LANGUAGE_ID_SEGMENTATION_POLICY` (`minSegmentMs: 1500`) |
| `speech_vad_model` | ✅ | Model-based speech cuts; pass VAD pack via policy `modelPath` |
| `continuous_frames` | ❌ | Fixed windows are a poor fit for utterance-level language ID |
| `speech_pyannote_segmentation` | ❌ | Not in SLID live `supportedEvaluators` |

SLID attaches the engine — you do **not** pass a pre-built VAD segment In from the app for the worker path. Policy tuning: [segmentation-engine.md](segmentation-engine.md).

## Pipeline handle

Same control surface as other streaming / live-overload features ([streaming-pipelines-overview.md](streaming-pipelines-overview.md)):

| Method | Behavior |
| --- | --- |
| `stop()` | Stop identify, flush remaining committed spans, resolve `completed` with `reason: 'stopped'`. |
| `flush()` | Identify **already-committed** spans. Open tail emits on `stop` / input finalize. |
| `reset()` | Clears progress counters while the pipeline remains running. |
| `getStatus()` | `{ pipelineId, isRunning, chunksProcessed, unitsRead, unitsWritten, error }` |
| `completed` | Resolves on graceful finalize (`completed`) or `stop()` (`stopped`); rejects on fatal errors (`STREAMING_PIPELINE_ERROR`). |

## API reference

```ts
identify(
  audioIn: LiveAudioBufferIdSource,
  textOut: LiveTextBufferIdSource,
  options: LanguageIdentificationLivePipelineOptions
): Promise<LanguageIdentificationPipelineHandle>;
```

```ts
type LanguageIdentificationLivePipelineOptions = {
  segmentation: {
    policy: SegmentationPolicy; // speech_energy_silence | speech_vad_model
    mode?: 'auto';
  };
  onSegment?: (event: LanguageIdSegmentEvent) => void;
  onLanguageChanged?: (event: LanguageChangedEvent) => void;
  targetSegmentBuffer?: LiveSegmentBufferIdSource;
};
```

## Optional `targetSegmentBuffer`

Pass a live segment buffer to append the same payload as offline label:

```ts
payload: { source: 'languageId'; lang: string }
```

## Error codes

| Code / token | Typical reason |
| --- | --- |
| `LIVE_OFFLINE_SEGMENTATION_REQUIRED` | Missing `segmentation` / `policy`, or `mode !== 'auto'`. |
| `LANGUAGE_ID_INVALID_ARGUMENT` | Non-live audio/text (or bad options). |
| `LANGUAGE_ID_IDENTIFY_FAILED` | Live start / identify path failed. |
| `STREAMING_PIPELINE_ERROR` | Fatal error during the run; `completed` rejects with this `code`. |
| `LANGUAGE_ID_*` / `SEGMENT_*` | Same codes as [offline SLID](language-identification-offline.md#error-codes). |

## See also

- [Spoken language identification (offline)](language-identification-offline.md)
- [Streaming pipelines — shared lifecycle](streaming-pipelines-overview.md)
- [Segmentation engine](segmentation-engine.md)
- [Pipeline audio buffers — streaming](audiobuffer-streaming.md)
- [Pipeline text buffers — live](textbuffer-streaming.md)
- [Speaker Identification (live overload)](speaker-identification-live.md) — same live-overload pattern

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread, inspect the SDK **last-activity ring buffer**. Full details: [native-diagnostics.md](./native-diagnostics.md).
