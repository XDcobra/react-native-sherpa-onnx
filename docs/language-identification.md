# Spoken Language Identification (SLID)

## Introduction

On-device **spoken language identification** using **Whisper multilingual** models from sherpa-onnx. Returns ISO 639-1 codes (e.g. `en`, `zh`, `de`, `ja`).

| Role | Type | Notes |
| --- | --- | --- |
| **Audio in (offline)** | [`OfflineAudioBuffer`](audiobuffer-offline.md) | Short clip (oneshot) or long-form (segmented) |
| **Audio in (live)** | [`LiveAudioBuffer`](audiobuffer-streaming.md) | Mic / file ingest |
| **Text out (live)** | [`LiveTextBuffer`](textbuffer-streaming.md) | Committed language tags per utterance |
| **Segments out (optional)** | [`OfflineSegmentBuffer`](segmentbuffer-offline.md) / [`LiveSegmentBuffer`](segmentbuffer-streaming.md) | `payload.source: 'languageId'`, `lang` |
| **Engine** | `LanguageIdentificationEngine` via `createLanguageIdentification` | Three `identify` overloads |

Import path: **`react-native-sherpa-onnx/language-identification`**.

Sherpa-onnx exposes SLID **only as an offline** Whisper path (no `OnlineSpokenLanguageIdentification`). This SDK adds:

1. **Mode 1 — Offline oneshot** — single pass ≤ ~30 s (native Whisper truncate).
2. **Mode 2 — Offline segmented** — [segmentation engine](segmentation-engine.md) slices long audio; duration-weighted `distribution` + `switches` for code-switching.
3. **Mode 3 — Live overload** — speech segmentation + offline identify per committed span (same live-overload pattern as [SID live](speaker-identification-live.md)).

**Models:** Reuse multilingual Whisper STT packs (`encoder` + `decoder`). Category `ModelCategory.LanguageId`. Exclude aishell fine-tunes / English-only Whisper variants.

## Buffer matrix

| | Offline oneshot | Offline segmented | Live overload |
| --- | --- | --- | --- |
| **Audio in** | `OfflineAudioBuffer` | `OfflineAudioBuffer` | `LiveAudioBuffer` |
| **Text out** | — | — | `LiveTextBuffer` (required) |
| **Segments out** | optional `targetSegmentBuffer` | optional `targetSegmentBuffer` | optional `targetSegmentBuffer` |
| **Return** | `{ lang, audioDuration, elapsedMs }` | `{ dominantLanguage, distribution, switches, segments, … }` | `LanguageIdentificationPipelineHandle` |

## Quick start — oneshot (Mode 1)

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
if (!det.success) {
  throw new Error(det.error ?? 'Language ID detection failed');
}

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

Omit `segmentation` or set `{ mode: 'off' }` for oneshot. Audio longer than ~30 s is truncated by native Whisper — use Mode 2 for long files or code-switching timelines.

## Segmented long-form & code-switching (Mode 2)

```ts
const result = await slid.identify(audio, {
  segmentation: {
    mode: 'auto',
    policy: {
      evaluator: 'speech_energy_silence',
      silenceThresholdMs: 500,
      energyThresholdDb: -40,
      minSegmentMs: 1500, // Whisper SLID needs ~1.5–3 s of speech
      maxSegmentMs: 25000,
      hangoverMs: 300,
    },
  },
  onProgress: (p) => console.log(p.completed, '/', p.total),
  onSegment: (e) => console.log('#', e.segmentIndex, e.lang),
  onLanguageChanged: (e) =>
    console.log('switch', e.previousLang, '→', e.currentLang, '@', e.timestamp),
});

console.log(result.dominantLanguage);
console.log(result.distribution); // e.g. { zh: 0.55, en: 0.45 }
console.log(result.switches); // [{ timestamp, from, to, segmentIndex }, …]
```

Default policy constant: `DEFAULT_LANGUAGE_ID_SEGMENTATION_POLICY` (`minSegmentMs: 1500`).

Acoustic SLID is **inter-sentential** (segment-level). Word-level intra-sentential switching belongs to STT decoders, not this API.

### Optional: populate `targetSegmentBuffer`

Pass an empty offline segment buffer to attach `LanguageIdSpeechSegmentPayload` (`source: 'languageId'`, `lang`) for downstream pipelines (e.g. Audio → VAD → Language ID → STT).

### `labelOfflineSegments`

Annotate an existing speech segment buffer without re-running segmentation:

```ts
const labeled = await slid.labelOfflineSegments(
  audioIn,
  segmentsIn,
  segmentsOut,
  {
    onSegment: (e) => console.log(e.lang),
    onLanguageChanged: (e) => console.log(e.previousLang, '→', e.currentLang),
  }
);
// { labeledCount, dominantLanguage, distribution, switches }
```

## Live overload (Mode 3)

> **Live overload** — not a streaming SLID model.
>
> Same offline Whisper weights as Modes 1–2. Live audio is sliced by a **mandatory speech segmentation policy**; each committed utterance is identified natively inside an `OfflineLivePipelineWorker`.

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
      minSegmentMs: 1500,
      maxSegmentMs: 25000,
      hangoverMs: 300,
    },
  },
  onSegment: (e) => console.log('#', e.segmentIndex, e.lang, e.durationMs),
  onLanguageChanged: (e) =>
    console.log(e.previousLang, '→', e.currentLang, '@', e.timestamp),
});

const mic = await startMicToLiveAudioBuffer(audioIn);
// … speak …
await stopMicToLiveAudioBuffer(mic);
await finalizeLiveAudioBuffer(audioIn);
await pipeline.completed;

await releasePipelineTextBuffer(textOut);
await releasePipelineAudioBuffer(audioIn);
```

`finalizeLiveAudioBuffer(audioIn)` drains remaining spans and resolves `completed`. Prefer that over an early `stop()` when the session ends naturally.

Spans shorter than ~1500 ms are skipped (insufficient evidence for Whisper SLID). Optional `targetSegmentBuffer` (live) attaches the same `languageId` payload for composition.

Pipeline handle: `stop` / `flush` / `getStatus` / `completed` (see [streaming pipelines overview](streaming-pipelines-overview.md)).

## Models

| | |
| --- | --- |
| **Category** | `ModelCategory.LanguageId` (`'languageId'`) |
| **Architecture** | Whisper multilingual only (`LanguageIdModelType = 'whisper'`) |
| **Files** | `encoder` + `decoder` ONNX (same layout as STT Whisper) |
| **Detect** | `detectLanguageIdModel(source, { modelType?, quantization? })` |
| **Custom init** | `customConfig: { encoder: FileSource; decoder: FileSource }` |
| **Quantization** | `'auto' \| 'int8' \| 'fp16' \| 'fp32' \| …` (universal preference) |

**Reuse:** Prefer packs already downloaded for Whisper STT. Do **not** use aishell fine-tunes or English-only Whisper for SLID (metadata requires `model_type == "whisper"` and `is_multilingual == 1`).

Whisper language coverage follows upstream multilingual Whisper (dozens of ISO codes). Demo assets in the example app include EN / ZH / JA / KO mono clips and `2-zh-en.wav` for code-switching.

## Types & errors

Key types: `LanguageIdentificationResult`, `SegmentedLanguageIdentificationResult`, `LanguageSwitchEntry`, `LanguageIdSegmentEntry`, `LanguageChangedEvent`, `LanguageIdSegmentEvent`, `LanguageIdentificationLivePipelineOptions`, `LabelOfflineSegmentsResult`.

Error codes (`LanguageIdErrorCode`): `LANGUAGE_ID_NOT_INITIALIZED`, `LANGUAGE_ID_ALREADY_INITIALIZED`, `LANGUAGE_ID_INVALID_ARGUMENT`, `LANGUAGE_ID_AUDIO_BUFFER_NOT_FOUND`, `LANGUAGE_ID_AUDIO_BUFFER_EMPTY`, `LANGUAGE_ID_INIT_ERROR`, `LANGUAGE_ID_IDENTIFY_FAILED`, `LANGUAGE_ID_DESTROYED`.

## See also

- [STT offline — Whisper](stt-offline.md)
- [Segmentation engine](segmentation-engine.md)
- [Speaker identification (live overload pattern)](speaker-identification-live.md)
- [Streaming pipelines overview](streaming-pipelines-overview.md)
- [Model detection & init](model-detect.md)
