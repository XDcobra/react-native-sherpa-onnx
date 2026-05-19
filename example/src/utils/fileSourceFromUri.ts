import { Platform } from 'react-native';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';

/** decodeURI that never throws (malformed % sequences from pickers). */
function safeDecodeUri(encoded: string): string {
  try {
    return decodeURI(encoded);
  } catch {
    return encoded;
  }
}

/** Map a filesystem path or content URI to a {@link FileSource}. */
export function toFileSource(pathOrUri: string): FileSource {
  const trimmed = pathOrUri.trim();

  if (trimmed.startsWith('content://')) {
    return { kind: 'contentUri', uri: trimmed };
  }

  if (trimmed.startsWith('file://')) {
    return {
      kind: 'fs',
      path: safeDecodeUri(trimmed.replace(/^file:\/\//, '')),
    };
  }

  return { kind: 'fs', path: trimmed };
}

/**
 * Bundled example audio under the app package.
 * - Android: `app` + `apkAsset` → `src/main/assets/<relativePath>`
 * - iOS: `app` + `files` with bundle Resources fallback (see FileIOResolver)
 */
export function fileSourceFromBundledPath(relativePath: string): FileSource {
  if (Platform.OS === 'android') {
    return {
      kind: 'app',
      base: 'apkAsset',
      path: relativePath,
    };
  }
  return {
    kind: 'app',
    base: 'files',
    path: relativePath,
  };
}

/** Short label for UI (kind + path or URI tail). */
export function describeFileSource(source: FileSource): string {
  switch (source.kind) {
    case 'fs':
      return `fs: ${source.path}`;
    case 'app':
      return `app/${source.base}: ${source.path}`;
    case 'contentUri': {
      const tail =
        source.uri.length > 48 ? `…${source.uri.slice(-40)}` : source.uri;
      return `contentUri: ${tail}`;
    }
    case 'securityScoped': {
      const tail =
        source.uri.length > 48 ? `…${source.uri.slice(-40)}` : source.uri;
      return `securityScoped: ${tail}`;
    }
    case 'pad':
      return `pad: ${source.packName}/${source.path}`;
    default:
      return 'unknown';
  }
}
