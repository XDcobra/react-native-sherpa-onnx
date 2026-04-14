# Audio conversion (`react-native-sherpa-onnx/audio`)

This module converts pipeline audio buffers to encoded audio files.

The conversion input is always a pipeline buffer id/reference (offline or finalized live), not a file path.
The output is a **`FileDestination`** descriptor (from `react-native-sherpa-onnx/fileio`) — filesystem path, app directory, content URI, SAF tree, or security-scoped URL.

## Overview

Exports:

- `convertAudioToFormat(input, output, format, options?)` → `Promise<ResolvedFileRef>`
- `convertAudioToWav16k(input, output)` → `Promise<ResolvedFileRef>`
- `AudioOutputFormat`
- `AudioConversionOptions`
- `ConversionErrorCode`
- `ConversionErrorCodeValue`

Key behavior:

- Conversion uses FFmpeg for all formats, including WAV.
- Input accepts `PipelineAudioBufferIdSource` (buffer ref, handle, info, or raw id string).
- Output accepts `FileDestination` (see [fileio.md](fileio.md) for kinds).
- Live buffers must be finalized before conversion.
- Buffer contents are not modified by conversion.
- Returns `ResolvedFileRef` describing the written output location.
- Android SAF destinations (`contentUri`, `contentTree`) use **direct fd-backed output** first (`/proc/self/fd/<n>`), with temp-file fallback only when a provider cannot supply a seekable fd.

## Examples

### Offline buffer -> MP3

```ts
import { createOfflineAudioBufferFromFile, releasePipelineAudioBuffer } from 'react-native-sherpa-onnx/audiobuffer';
import { convertAudioToFormat } from 'react-native-sherpa-onnx/audio';

const buf = await createOfflineAudioBufferFromFile({ kind: 'fs', path: '/tmp/in.wav' });
try {
  const ref = await convertAudioToFormat(buf, { kind: 'fs', path: '/tmp/out.mp3' }, 'mp3', { outputSampleRateHz: 44100 });
  console.log('Written to:', ref);
} finally {
  await releasePipelineAudioBuffer(buf).catch(() => {});
}
```

### Finalized live buffer -> FLAC

```ts
import {
  createLiveAudioBuffer,
  startMicToLiveAudioBuffer,
  stopMicToLiveAudioBuffer,
  finalizeLiveAudioBuffer,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import { convertAudioToFormat } from 'react-native-sherpa-onnx/audio';

const live = await createLiveAudioBuffer({ sampleRate: 44100 });
await startMicToLiveAudioBuffer(live);
// recording...
await stopMicToLiveAudioBuffer();
await finalizeLiveAudioBuffer(live);

try {
  await convertAudioToFormat(live, { kind: 'fs', path: '/tmp/recording.flac' }, 'flac');
} finally {
  await releasePipelineAudioBuffer(live).catch(() => {});
}
```

### Buffer -> WAV 16 kHz

```ts
import { convertAudioToWav16k } from 'react-native-sherpa-onnx/audio';

await convertAudioToWav16k(buffer, { kind: 'fs', path: '/tmp/stt_input.wav' });
```

### Encode to SAF directory (Android)

```ts
const ref = await convertAudioToFormat(
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

### Progress & cancellation

```ts
const controller = new AbortController();

const ref = await convertAudioToFormat(
  buffer,
  { kind: 'fs', path: '/tmp/out.mp3' },
  'mp3',
  {
    outputSampleRateHz: 44100,
    signal: controller.signal,
    onProgress: (e) => console.log(`${e.percent}%`),
  }
);
```

`onProgress` is best-effort. In the current implementation, direct encoder writes do not emit intermediate progress events.

## API reference

### `convertAudioToFormat(input, output, format, options?)`

Convert an offline or finalized live buffer to an encoded audio file at the given destination.

```ts
export function convertAudioToFormat(
  input: PipelineAudioBufferIdSource,
  output: FileDestination,
  format: AudioOutputFormat,
  options?: AudioConversionOptions,
): Promise<ResolvedFileRef>;
```

```ts
import { convertAudioToFormat } from 'react-native-sherpa-onnx/audio';

const ref = await convertAudioToFormat(buffer, { kind: 'fs', path: '/tmp/out.mp3' }, 'mp3', { outputSampleRateHz: 44100 });
```

Parameters:

- `input`: `PipelineAudioBufferIdSource`
- `output`: `FileDestination` — where to write the encoded file
- `format`: `AudioOutputFormat`
- `options`: `AudioConversionOptions` (optional)
  - `outputSampleRateHz?: number` — target sample rate (`0` or omitted = format default)
  - `signal?: AbortSignal` — cancel the operation
  - `onProgress?: (event: FileIOProgressEvent) => void` — progress updates

Returns:

- `Promise<ResolvedFileRef>` — `{ kind: 'fs', path }` or `{ kind: 'contentUri', uri }`

### `convertAudioToWav16k(input, output)`

Shortcut for:

```ts
convertAudioToFormat(input, output, 'wav', { outputSampleRateHz: 16000 })
```

Use this for STT-prepared WAV output.

## Sample-rate semantics

- `wav`: `0` uses buffer native rate, explicit value resamples.
- `mp3`: `0` -> `44100`; allowed: `32000`, `44100`, `48000`.
- `opus` / `webm` / `mkv` / `ogg`: `0` -> `48000`; allowed: `8000`, `12000`, `16000`, `24000`, `48000`.
- `flac` / `aac` / `m4a`: `0` uses buffer native rate, explicit value resamples.

## Error codes

Promise rejections use conversion-specific codes:

| Error code | Explanation |
| --- | --- |
| `CONVERSION_INVALID_ARGUMENT` | Invalid input arguments (e.g. malformed buffer id or invalid path input). |
| `CONVERSION_BUFFER_NOT_FOUND` | The provided buffer id/reference does not exist in the native registry. |
| `CONVERSION_BUFFER_NOT_FINALIZED` | A live buffer is still recording and must be finalized before conversion. |
| `CONVERSION_BUFFER_EMPTY` | The resolved input buffer contains no samples. |
| `CONVERSION_UNSUPPORTED_FORMAT` | The requested output format is not supported by the conversion pipeline. |
| `CONVERSION_INVALID_SAMPLE_RATE` | The provided `outputSampleRateHz` is invalid for the selected output format. |
| `CONVERSION_CONVERT_ERROR` | Native conversion/encoding failed during processing. |
| `CONVERSION_FILE_WRITE_ERROR` | Output file could not be created or written. |

Use `ConversionErrorCode` from `react-native-sherpa-onnx/audio` for stable comparisons.

## Platform notes

- Android and iOS both support all documented output formats through the same conversion API.
- FFmpeg is required for all conversions, including WAV.
- If FFmpeg is disabled, conversion calls reject at runtime.

## Output destination

`output` accepts any `FileDestination` kind.

- Android `contentUri` / `contentTree`: native resolves a seekable `ParcelFileDescriptor` and FFmpeg writes directly to `/proc/self/fd/<n>`.
- Fallback: if a SAF provider does not support seekable fd output, native falls back to temp-file + stream copy.
- iOS: output remains path-based (`fs` / `app` / `securityScoped`).

See [fileio.md](fileio.md) for platform support per kind.

## Related

- [docs/audiobuffer-offline.md](audiobuffer-offline.md)
- [docs/audiobuffer-streaming.md](audiobuffer-streaming.md)
- [docs/fileio.md](fileio.md)
- [docs/disable-ffmpeg.md](disable-ffmpeg.md)
