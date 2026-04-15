# File I/O (`react-native-sherpa-onnx/fileio`)

Generic file operations using **`FileSource`** and **`FileDestination`** descriptors. Supports filesystem paths, app directories, Android `content://` URIs, Android SAF directory trees, iOS security-scoped URLs, and Android Play Asset Delivery (`pad`) sources.

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
  | { kind: 'contentTree'; treeUri: string; filename: string; mimeType: string }
  | { kind: 'securityScoped'; uri: string };

type AppBaseDir = 'cache' | 'documents' | 'files' | 'tmp' | 'externalFiles';
```

## Platform notes

| Kind | Android | iOS |
|------|---------|-----|
| `fs` | Absolute path | Absolute path |
| `app` | `cache`/`documents`/`files`/`tmp`/`externalFiles` | `cache`/`documents`/`files`/`tmp` (`externalFiles` unsupported) |
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
if (result.output.kind === 'fs') {
  console.log(result.output.path); // absolute cache path
}

// Copy local file to SAF tree
await copyFile(
  { kind: 'fs', path: '/data/.../out.mp3' },
  { kind: 'contentTree', treeUri: dirUri, filename: 'out.mp3', mimeType: 'audio/mpeg' }
);

// Share a file
await shareFile({ kind: 'fs', path: '/path/to/out.wav' }, { mimeType: 'audio/wav' });

// Save text to SAF tree
await saveText('Hello', {
  kind: 'contentTree',
  treeUri: dirUri,
  filename: 'note.txt',
  mimeType: 'text/plain',
});
```

## Progress & cancellation

`copyFile` supports progress callbacks and `AbortSignal` cancellation:

```ts
const controller = new AbortController();

const result = await copyFile(
  { kind: 'fs', path: largePath },
  { kind: 'contentTree', treeUri: dirUri, filename: 'big.wav', mimeType: 'audio/wav' },
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

Copy bytes from source to destination. Returns `{ bytesCopied, output }`.

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

- `encoding?: 'utf8'` — text encoding (default: `utf8`)
- `overwrite?: boolean` — overwrite destination if it already exists (default: `true`)

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
  bytesCopied: number;
  output: ResolvedFileRef;
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
| `FILEIO_INVALID_ARGUMENT` | Argument validation failed |
| `FILEIO_UNSUPPORTED_LOCATION_KIND` | Unknown source/destination kind |
| `FILEIO_UNSUPPORTED_ON_PLATFORM` | Kind is valid but not supported on this platform |
| `FILEIO_PERMISSION_DENIED` | Missing permission for the operation |
| `FILEIO_NOT_FOUND` | Source file/URI does not exist |
| `FILEIO_ALREADY_EXISTS` | Destination exists and overwrite=false |
| `FILEIO_READ_ERROR` | Error while reading source |
| `FILEIO_WRITE_ERROR` | Error while writing destination |
| `FILEIO_RESOLVE_ERROR` | Resolver could not map source/destination |
| `FILEIO_CANCELLED` | Operation cancelled via AbortSignal |
| `FILEIO_PATH_TRAVERSAL_BLOCKED` | App-relative path escaped base directory |

## Integration with other modules

`FileSource` and `FileDestination` are also accepted by:

- [`createOfflineAudioBufferFromFile(source)`](audiobuffer-offline.md) — decode audio from any source
- [`saveAudioAsFile(input, output, format, options?)`](audio-conversion.md) — save audio to any destination

## Related

- [Audio conversion](audio-conversion.md) (`react-native-sherpa-onnx/audio`)
- [Offline audio buffers](audiobuffer-offline.md) (`react-native-sherpa-onnx/audiobuffer`)
- [Migration guide](migration.md)
