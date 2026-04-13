# Audio conversion (`react-native-sherpa-onnx/audio`)

This module converts pipeline audio buffers to encoded audio files.

The conversion input is always a pipeline buffer id/reference (offline or finalized live), not a file path.

## Overview

Exports:

- `convertAudioToFormat(input, outputPath, format, outputSampleRateHz?)`
- `convertAudioToWav16k(input, outputPath)`
- `AudioOutputFormat`
- `ConversionErrorCode`
- `ConversionErrorCodeValue`

Key behavior:

- Conversion uses FFmpeg for all formats, including WAV.
- Input accepts `PipelineAudioBufferIdSource` (buffer ref, handle, info, or raw id string).
- Live buffers must be finalized before conversion.
- Buffer contents are not modified by conversion.

## Examples

### Offline buffer -> MP3

```ts
import { createOfflineAudioBufferFromFile, releasePipelineAudioBuffer } from 'react-native-sherpa-onnx/audiobuffer';
import { convertAudioToFormat } from 'react-native-sherpa-onnx/audio';

const buf = await createOfflineAudioBufferFromFile('/tmp/in.wav');
try {
  await convertAudioToFormat(buf, '/tmp/out.mp3', 'mp3', 44100);
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
  await convertAudioToFormat(live, '/tmp/recording.flac', 'flac');
} finally {
  await releasePipelineAudioBuffer(live).catch(() => {});
}
```

### Buffer -> WAV 16 kHz

```ts
import { convertAudioToWav16k } from 'react-native-sherpa-onnx/audio';

await convertAudioToWav16k(buffer, '/tmp/stt_input.wav');
```

## API reference

### `convertAudioToFormat(input, outputPath, format, outputSampleRateHz?)`

Convert an offline or finalized live buffer to an output file.

```ts
export function convertAudioToFormat(
  input: PipelineAudioBufferIdSource,
  outputPath: string,
  format: AudioOutputFormat,
  outputSampleRateHz?: number,
): Promise<void>;
```

```ts
import { convertAudioToFormat } from 'react-native-sherpa-onnx/audio';

await convertAudioToFormat(buffer, '/tmp/out.mp3', 'mp3', 44100);
```

Parameters:

- `input`: `PipelineAudioBufferIdSource`
- `outputPath`: absolute local file path
- `format`: `AudioOutputFormat`
- `outputSampleRateHz`: optional target sample rate (`0` or omitted = format default)

Returns:

- `Promise<void>`

### `convertAudioToWav16k(input, outputPath)`

Shortcut for:

```ts
convertAudioToFormat(input, outputPath, 'wav', 16000)
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

## Output-path rules

- `outputPath` must be an absolute local file path.
- Parent directory must already exist.
- Existing file may be overwritten.
- `content://` is not accepted as `outputPath`.

For Android SAF:

1. convert to local path
2. copy with `copyFileToContentUri` from `react-native-sherpa-onnx/files`

## Related

- [docs/audiobuffer-offline.md](audiobuffer-offline.md)
- [docs/audiobuffer-streaming.md](audiobuffer-streaming.md)
- [docs/files.md](files.md)
- [docs/disable-ffmpeg.md](disable-ffmpeg.md)
