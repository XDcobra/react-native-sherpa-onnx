# Files (persistence & sharing)

Helpers for **Android Storage Access Framework (SAF)**, copying **`content://`** URIs to cache, sharing files, and writing text.

This module does not encode audio itself. For audio export, first convert a pipeline buffer to a local file via [`react-native-sherpa-onnx/audio`](audio-conversion.md), then use this module for SAF copy/share operations.

**Import path:** `react-native-sherpa-onnx/files`

The package root also re-exports **`copyFileToContentUri`** for convenience (`import { copyFileToContentUri } from 'react-native-sherpa-onnx'`).

## Peer / platform notes

- **Android:** SAF directory URIs (`content://…`) for `saveTextToContentUri` and `copyFileToContentUri`.
- **iOS:** `copyFileToContentUri` is not supported (rejects). `saveTextToContentUri` writes into a normal filesystem directory path or `file://` URL. `copyContentUriToCache` copies **file paths** (not `content://`). `shareAudioFile` uses `UIActivityViewController`.

## Quick start

```ts
import {
  copyContentUriToCache,
  copyFileToContentUri,
  saveTextToContentUri,
  shareAudioFile,
} from 'react-native-sherpa-onnx/files';

// User-picked audio on Android → cache path for native code
const path = await copyContentUriToCache(uri, 'reference.wav');

// After convertAudioToFormat -> copy encoded file into SAF tree
await copyFileToContentUri('/cache/out.mp3', dirUri, 'out.mp3', 'audio/mpeg');

await shareAudioFile('/path/to/out.wav', 'audio/wav');

await saveTextToContentUri('Hello', dirUri, 'note.txt', 'text/plain');
```

## API reference

### `copyFileToContentUri(filePath, directoryUri, filename, mimeType)`

```ts
function copyFileToContentUri(
  filePath: string,
  directoryUri: string,
  filename: string,
  mimeType: string
): Promise<string>;
```

**Android:** Copies an existing file into a document under a SAF directory. Resolves with the new document’s `content://` URI.

**iOS:** Not supported (rejects).

### `copyContentUriToCache(fileUri, filename)`

```ts
function copyContentUriToCache(fileUri: string, filename: string): Promise<string>;
```

**Android:** Reads a `content://` URI and writes into app cache; resolves with an absolute file path.

**iOS:** Copies a **file path** (or `file://`) into cache; `content://` is not supported.

### `shareAudioFile(fileUri, mimeType?)`

```ts
function shareAudioFile(fileUri: string, mimeType?: string): Promise<void>;
```

Opens the system share sheet. **`mimeType`** defaults to `audio/wav`.

### `saveTextToContentUri(text, directoryUri, filename, mimeType?)`

```ts
function saveTextToContentUri(
  text: string,
  directoryUri: string,
  filename: string,
  mimeType?: string
): Promise<string>;
```

**Android:** Writes UTF-8 text into a new document under the SAF tree URI.

**iOS:** Writes into a directory path (see platform notes above).

## Related

- [Offline TTS](tts-offline.md)
- [`convertAudioToFormat`](audio-conversion.md) (`react-native-sherpa-onnx/audio`)
- [Migration: imports & TurboModule names](migration.md#files-api-persistence--sharing-helpers)
