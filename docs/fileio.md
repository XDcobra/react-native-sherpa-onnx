# File I/O (`react-native-sherpa-onnx/fileio`)

Generic file operations using **`FileSource`** and **`FileDestination`** descriptors. Supports filesystem paths, app directories (cache/documents), Android `content://` URIs, Android SAF directory trees, and iOS security-scoped URLs.

**Import path:** `react-native-sherpa-onnx/fileio`

The package root also re-exports `copyFile`, `saveText`, `shareFile`, and all types for convenience.

## Concepts

Instead of method-per-platform helpers (`copyContentUriToCache`, `copyFileToContentUri`, etc.), all file operations use a unified **source → destination** pattern with discriminated union descriptors:

```ts
type FileSource =
  | { kind: 'fs'; path: string }
  | { kind: 'app'; base: AppBaseDir; path: string }
  | { kind: 'contentUri'; uri: string }
  | { kind: 'securityScoped'; uri: string }
  | { kind: 'pad'; packName: string; path: string };

type FileDestination =
  | { kind: 'fs'; path: string }
  | { kind: 'app'; base: AppBaseDir; path: string }
  | { kind: 'contentUri'; uri: string }
  | { kind: 'contentTree'; treeUri: string; displayName: string; mimeType?: string }
  | { kind: 'securityScoped'; uri: string };

type AppBaseDir = 'cache' | 'documents';
```

## Platform notes

| Kind | Android | iOS |
|------|---------|-----|
| `fs` | Absolute path | Absolute path |
| `app` | Cache or documents dir | Cache or documents dir |
| `contentUri` | SAF document URI | Rejects |
| `contentTree` | SAF tree URI (creates document) | Rejects |
| `securityScoped` | Rejects | Security-scoped bookmark URL |
| `pad` | Play Asset Delivery pack | Rejects |

## Quick start

```ts
import { copyFile, saveText, shareFile } from 'react-native-sherpa-onnx/fileio';
import type { FileSource, FileDestination } from 'react-native-sherpa-onnx/fileio';

// Copy a user-picked content URI to app cache
const result = await copyFile(
  { kind: 'contentUri', uri: pickedUri },
  { kind: 'app', base: 'cache', path: 'reference.wav' }
);
console.log(result.outputPath); // absolute cache path

// Copy local file to SAF tree
await copyFile(
  { kind: 'fs', path: '/data/.../out.mp3' },
  { kind: 'contentTree', treeUri: dirUri, displayName: 'out.mp3', mimeType: 'audio/mpeg' }
);

// Share a file
await shareFile({ kind: 'fs', path: '/path/to/out.wav' }, { mimeType: 'audio/wav' });

// Save text to SAF tree
await saveText('Hello', { kind: 'contentTree', treeUri: dirUri, displayName: 'note.txt' });
```

## Progress & cancellation

`copyFile` supports progress callbacks and `AbortSignal` cancellation:

```ts
const controller = new AbortController();

const result = await copyFile(
  { kind: 'fs', path: largePath },
  { kind: 'contentTree', treeUri: dirUri, displayName: 'big.wav' },
  {
    signal: controller.signal,
    onProgress: (event) => {
      console.log(`${event.percent}% (${event.bytesTransferred}/${event.totalBytes})`);
    },
  }
);

// To cancel: controller.abort();
```

## API reference

### `copyFile(source, destination, options?)`

```ts
function copyFile(
  source: FileSource,
  destination: FileDestination,
  options?: CopyFileOptions
): Promise<CopyFileResult>;
```

Copy bytes from source to destination. Returns `{ outputKind, outputPath }` describing the written location.

**Options:**

- `signal?: AbortSignal` — cancel the operation
- `onProgress?: (event: FileIOProgressEvent) => void` — progress updates

### `saveText(text, destination, options?)`

```ts
function saveText(
  text: string,
  destination: FileDestination,
  options?: SaveTextOptions
): Promise<ResolvedFileRef>;
```

Write UTF-8 text to the destination. Returns a `ResolvedFileRef`.

**Options:**

- `mimeType?: string` — MIME type for `contentTree` destinations (default: `text/plain`)

### `shareFile(source, options?)`

```ts
function shareFile(
  source: FileSource,
  options?: ShareFileOptions
): Promise<void>;
```

Open the system share sheet for the given file.

**Options:**

- `mimeType?: string` — MIME type hint

## Types

### `ResolvedFileRef`

Returned by write operations. Tells you where the file ended up:

```ts
type ResolvedFileRef =
  | { kind: 'fs'; path: string }
  | { kind: 'contentUri'; uri: string };
```

### `CopyFileResult`

```ts
interface CopyFileResult {
  outputKind: string;
  outputPath: string;
}
```

### `FileIOProgressEvent`

```ts
interface FileIOProgressEvent {
  bytesTransferred: number;
  totalBytes: number;
  percent: number;
}
```

### `FileIOErrorCode`

Error codes thrown by file I/O operations:

| Code | Meaning |
|------|---------|
| `FILEIO_SOURCE_NOT_FOUND` | Source file/URI does not exist |
| `FILEIO_DEST_NOT_WRITABLE` | Destination cannot be written |
| `FILEIO_PERMISSION_DENIED` | Missing permission for the operation |
| `FILEIO_UNSUPPORTED_KIND` | Source/destination kind not supported on this platform |
| `FILEIO_INVALID_ARGUMENT` | Missing or malformed argument |
| `FILEIO_COPY_FAILED` | Copy stream failed |
| `FILEIO_CANCELLED` | Operation cancelled via AbortSignal |
| `FILEIO_SHARE_FAILED` | Share sheet failed to open |
| `FILEIO_TEXT_WRITE_FAILED` | Text write failed |
| `FILEIO_PATH_TRAVERSAL` | Path traversal detected (e.g. `../`) in app-relative paths |
| `FILEIO_UNKNOWN` | Unexpected error |

## Integration with other modules

`FileSource` and `FileDestination` are also accepted by:

- [`createOfflineAudioBufferFromFile(source)`](audiobuffer-offline.md) — decode audio from any source
- [`convertAudioToFormat(input, output, format, options?)`](audio-conversion.md) — encode audio to any destination

## Related

- [Audio conversion](audio-conversion.md) (`react-native-sherpa-onnx/audio`)
- [Offline audio buffers](audiobuffer-offline.md) (`react-native-sherpa-onnx/audiobuffer`)
- [Migration guide](migration.md)
