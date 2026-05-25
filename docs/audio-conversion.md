# Audio (`react-native-sherpa-onnx/audio`)

## Introduction

Import from `react-native-sherpa-onnx/audio`. This page documents **save/encode**, **duration probe**, and **container probe**. Session/route coordination is in [audio-session.md](./audio-session.md).

Save/encode input can be either a pipeline audio buffer reference or a `FileSource`. Output is always a `FileDestination` from `react-native-sherpa-onnx/fileio`.

## Overview

Exports:

- `probeAudioFileDuration(source)` → `Promise<AudioFileDurationProbe | null>`
- `probeAudioFileContainer(source)` → `Promise<AudioFileContainerProbe | null>`
- `saveAudioAsFile(input, output, format, options?)` → `Promise<ResolvedFileRef>`
- `saveAudioAsWav16k(input, output)` → `Promise<ResolvedFileRef>`
- `AudioOutputFormat`
- `AudioSaveInput`
- `SaveAudioOptions`
- `AudioSaveProgressEvent`
- `AudioSaveErrorCode`
- `AudioSaveErrorCodeValue`

Key behavior:

- Input accepts either `PipelineAudioBufferIdSource` or `FileSource`.
- Output accepts any `FileDestination` kind supported by the current platform.
- Live buffers must be finalized before saving.
- Buffer contents are never modified by save operations.
- Returns a `ResolvedFileRef` describing the actual written output location.
- WAV uses a direct native fast path; lossy formats use the shared encode pipeline.
- Progress events are emitted on the `audioSaveProgress` channel with `decode`, `encode`, and `finalize` phases.

## Quick start

### Offline buffer to MP3

```ts
import {
  createOfflineAudioBufferFromFile,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import { saveAudioAsFile } from 'react-native-sherpa-onnx/audio';

const buf = await createOfflineAudioBufferFromFile({ kind: 'fs', path: '/tmp/in.wav' });
try {
  const ref = await saveAudioAsFile(
    buf,
    { kind: 'fs', path: '/tmp/out.mp3' },
    'mp3',
    { outputSampleRateHz: 44100, quality: 'high' }
  );
  console.log('Written to:', ref);
} finally {
  await releasePipelineAudioBuffer(buf).catch(() => {});
}
```

### File-to-file encode without creating a buffer

```ts
import { saveAudioAsFile } from 'react-native-sherpa-onnx/audio';

const ref = await saveAudioAsFile(
  { kind: 'fs', path: '/tmp/in.wav' },
  { kind: 'fs', path: '/tmp/out.opus' },
  'opus',
  { quality: 'medium' }
);
```

### Finalized live buffer to FLAC

```ts
import {
  createEmptyLiveAudioBuffer,
  finalizeLiveAudioBuffer,
  releasePipelineAudioBuffer,
  startMicToLiveAudioBuffer,
  stopMicToLiveAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import { saveAudioAsFile } from 'react-native-sherpa-onnx/audio';

const live = await createEmptyLiveAudioBuffer({ sampleRate: 44100 });
await startMicToLiveAudioBuffer(live);
// recording...
await stopMicToLiveAudioBuffer();
await finalizeLiveAudioBuffer(live);

try {
  await saveAudioAsFile(live, { kind: 'fs', path: '/tmp/recording.flac' }, 'flac');
} finally {
  await releasePipelineAudioBuffer(live).catch(() => {});
}
```

### Save to WAV 16 kHz

```ts
import { saveAudioAsWav16k } from 'react-native-sherpa-onnx/audio';

await saveAudioAsWav16k(buffer, { kind: 'fs', path: '/tmp/stt_input.wav' });
```

### Save to SAF directory on Android

```ts
import { saveAudioAsFile } from 'react-native-sherpa-onnx/audio';

const ref = await saveAudioAsFile(
  buffer,
  {
    kind: 'contentTree',
    treeUri: safDirUri,
    filename: 'speech.wav',
    mimeType: 'audio/wav',
  },
  'wav'
);

console.log(ref); // { kind: 'contentUri', uri: 'content://...' }
```

### Progress and cancellation

```ts
import { saveAudioAsFile } from 'react-native-sherpa-onnx/audio';

const controller = new AbortController();

const ref = await saveAudioAsFile(
  buffer,
  { kind: 'fs', path: '/tmp/out.mp3' },
  'mp3',
  {
    outputSampleRateHz: 44100,
    bitrate: 128,
    signal: controller.signal,
    onProgress: (event) => {
      console.log(event.phase, event.percent);
    },
  }
);
```

`onProgress` receives an `AudioSaveProgressEvent` with a per-operation `operationId`, current `phase`, frame counters, and percent.

## API reference

### `saveAudioAsFile(input, output, format, options?)`

Save an audio buffer or source file to the requested output format.

```ts
export function saveAudioAsFile(
  input: AudioSaveInput,
  output: FileDestination,
  format: AudioOutputFormat,
  options?: SaveAudioOptions,
): Promise<ResolvedFileRef>;
```

Parameters:

- `input`: `AudioSaveInput`
  - `PipelineAudioBufferIdSource` for offline or finalized live buffers
  - `FileSource` for direct file-to-file encode without buffer allocation
- `output`: `FileDestination`
- `format`: `AudioOutputFormat`
- `options`: `SaveAudioOptions`
  - `outputSampleRateHz?: number`
  - `quality?: 'low' | 'medium' | 'high'`
  - `bitrate?: number`
  - `signal?: AbortSignal`
  - `onProgress?: (event: AudioSaveProgressEvent) => void`

Returns:

- `Promise<ResolvedFileRef>`

### `saveAudioAsWav16k(input, output)`

Shortcut for:

```ts
saveAudioAsFile(input, output, 'wav', { outputSampleRateHz: 16000 })
```

Use this for STT-ready 16 kHz mono WAV output.

### `probeAudioFileDuration(source)`

Read file duration from container metadata only (WAV header or FFmpeg demux) — no PCM decode, no offline buffer. Use for usage estimates or planners before `createOfflineAudioBufferFromFile`.

```ts
export type AudioFileDurationProbe = {
  durationMs: number;
  isExact: boolean;
};

export async function probeAudioFileDuration(
  source: FileSource
): Promise<AudioFileDurationProbe | null>;
```

- `source`: `FileSource` from `react-native-sherpa-onnx/fileio` (`fs`, `contentUri`, … — same resolver as decode).
- Returns `null` on failure (wrapper swallows native `PROBE_*` rejections).
- `isExact`: `true` for WAV header math or stream/container duration; `false` when estimated from file size + bitrate.

### `probeAudioFileContainer(source)`

Read the detected **container format** and **primary audio codec** from file content (WAV header or FFmpeg demux). No PCM decode and no offline buffer allocation.

Use this to compare probe results against a filename extension, an allowlist, or other rules **in your app** — the SDK only returns neutral metadata (`inputFormatName`, `codecName`).

```ts
export type AudioFileContainerProbe = {
  /** FFmpeg `iformat->name`, e.g. `ogg`, `mp3`, `mov`, `matroska`, `wav`. */
  inputFormatName: string;
  /** Primary audio codec short name, e.g. `opus`, `aac`, `mp3`, `pcm_s16le`. */
  codecName: string;
};

export async function probeAudioFileContainer(
  source: FileSource
): Promise<AudioFileContainerProbe | null>;
```

- `source`: `FileSource` from `react-native-sherpa-onnx/fileio` (`fs`, `contentUri`, … — same resolver as decode).
- Returns `null` on failure (wrapper swallows native `PROBE_*` rejections).
- Probe uses FFmpeg **auto-probe** when needed so content is identified from bytes, not only from the path extension.
- Common result pairs (illustrative, not exhaustive): `wav` + `pcm_s16le`; `mp3` + `mp3`; `ogg` + `opus`; `mov` + `aac`; `matroska` + `opus`.

For `contentUri` / `securityScoped` sources, optional `displayName` on `FileSource` supplies a path extension hint when the resolved temp path has none:

```ts
await probeAudioFileContainer({
  kind: 'contentUri',
  uri: contentUri,
  displayName: 'recording.mp3',
});
```

Related decode option (optional, default `true`): `allowDemuxerAutoProbe` on `AudioDecodeOptions` / `FileIngestOptions`. When `false`, `avformat_open_input` does not fall back to auto-probe after the extension-specific demuxer fails (stricter open behavior; may reject files that only open via content sniffing).

## Sample-rate semantics

- `wav`: `0` uses the source sample rate; explicit values resample.
- `mp3`: `0` uses `44100`; allowed: `32000`, `44100`, `48000`.
- `opus`, `webm`, `mkv`, `ogg`: `0` uses `48000`; allowed: `8000`, `12000`, `16000`, `24000`, `48000`.
- `flac`, `aac`, `m4a`: `0` uses the source sample rate; explicit values resample.

## Quality and bitrate

- `bitrate` is interpreted as kbps and overrides `quality` when both are set.
- `quality` is mapped per codec:
  - MP3 and AAC: `low=64`, `medium=128`, `high=192`
  - Opus: `low=24`, `medium=64`, `high=128`
- `quality` and `bitrate` are ignored for `wav` and `flac`.

## Types and constants

```ts
import {
  probeAudioFileDuration,
  probeAudioFileContainer,
  saveAudioAsFile,
  saveAudioAsWav16k,
  AudioSaveErrorCode,
} from 'react-native-sherpa-onnx/audio';

import type {
  AudioFileDurationProbe,
  AudioFileContainerProbe,
  AudioOutputFormat,
  AudioSaveInput,
  SaveAudioOptions,
  AudioSaveProgressEvent,
  AudioSaveErrorCodeValue,
} from 'react-native-sherpa-onnx/audio';
```

## Error codes

Promise rejections use `AUDIO_SAVE_*` codes:

| Error code | Explanation |
| --- | --- |
| `AUDIO_SAVE_INVALID_ARGUMENT` | Invalid input arguments or malformed source/destination objects. |
| `AUDIO_SAVE_BUFFER_NOT_FOUND` | The referenced audio buffer does not exist in the native registry. |
| `AUDIO_SAVE_BUFFER_NOT_FINALIZED` | A live buffer is still recording and must be finalized first. |
| `AUDIO_SAVE_BUFFER_INVALIDATED` | A live buffer became invalid after transfer/disposal and can no longer be saved. |
| `AUDIO_SAVE_BUFFER_EMPTY` | The resolved input contains zero samples. |
| `AUDIO_SAVE_SOURCE_NOT_FOUND` | A `FileSource` input could not be resolved or decoded. |
| `AUDIO_SAVE_UNSUPPORTED_FORMAT` | The requested output format is not supported. |
| `AUDIO_SAVE_INVALID_SAMPLE_RATE` | `outputSampleRateHz` is invalid for the selected codec. |
| `AUDIO_SAVE_INVALID_QUALITY` | `quality` or `bitrate` values are invalid. |
| `AUDIO_SAVE_ENCODE_ERROR` | Native decode or encode processing failed. |
| `AUDIO_SAVE_FILE_WRITE_ERROR` | The destination file could not be written. |
| `AUDIO_SAVE_DESTINATION_INVALID` | Destination resolution produced an invalid output path. |
| `AUDIO_SAVE_CANCELLED` | The operation was cancelled via `AbortSignal`. |

Use `AudioSaveErrorCode` from `react-native-sherpa-onnx/audio` for stable comparisons.

## Platform notes

- Android and iOS both expose the same `saveAudioAsFile` / `saveAudioAsWav16k` API.
- Android `contentUri` and `contentTree` outputs use a seekable fd when possible, with temp-file fallback if a provider cannot support direct output.
- iOS output remains path-based through `fs`, `app`, and `securityScoped` destinations.
- If FFmpeg is disabled, formats that require the FFmpeg backend reject at runtime. See [disable-ffmpeg.md](disable-ffmpeg.md).

## Related

- [audio-session.md](audio-session.md)
- [audiobuffer-offline.md](audiobuffer-offline.md)
- [audiobuffer-streaming.md](audiobuffer-streaming.md)
- [fileio.md](fileio.md)
- [disable-ffmpeg.md](disable-ffmpeg.md)

## Use case examples

<details>
<summary>Normalize user-uploaded media to STT-friendly WAV 16 kHz output</summary>

```ts
const wavRef = await saveAudioAsWav16k(
  { kind: 'fs', path: '/tmp/uploaded-video-audio.m4a' },
  { kind: 'fs', path: '/tmp/stt-input.wav' }
);

console.log(wavRef);
```

</details>

<details>
<summary>Export finalized live recording to compressed Opus with progress UI</summary>

```ts
const exported = await saveAudioAsFile(
  liveBuffer,
  { kind: 'fs', path: '/tmp/recording.opus' },
  'opus',
  {
    quality: 'medium',
    onProgress: (event) => console.log(event.phase, event.percent),
  }
);

console.log(exported);
```

</details>
