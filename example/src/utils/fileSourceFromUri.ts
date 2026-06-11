import { Platform } from 'react-native';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';

const AUDIO_EXT_RE =
  /\.(aac|m4a|mp3|wav|flac|ogg|opus|wma|caf|aiff?|webm|mkv)$/i;

/** decodeURI that never throws (malformed % sequences from pickers). */
function safeDecodeUri(encoded: string): string {
  try {
    return decodeURI(encoded);
  } catch {
    return encoded;
  }
}

function basenameFromUri(uri: string): string {
  const withoutQuery = (uri.split('?')[0] ?? uri).trim();
  const segments = withoutQuery.split(/[/\\]/);
  return segments[segments.length - 1] ?? withoutQuery;
}

function hasAudioExtension(name: string): boolean {
  return AUDIO_EXT_RE.test(name);
}

/**
 * Best display name for native decode: picker hint, then URI basename if it has
 * a known audio extension. Omit extensionless hints so Android ContentResolver
 * can supply DISPLAY_NAME.
 */
export function resolveAudioFileDisplayName(
  uri: string,
  displayNameHint?: string | null,
  fallback = 'audio'
): string | undefined {
  const trimmedHint = displayNameHint?.trim();
  if (trimmedHint && hasAudioExtension(trimmedHint)) {
    return trimmedHint;
  }
  const fromUri = basenameFromUri(uri);
  if (hasAudioExtension(fromUri)) {
    return fromUri;
  }
  const loose = trimmedHint || fromUri || fallback;
  return hasAudioExtension(loose) ? loose : undefined;
}

/**
 * Map a filesystem path or content URI to a {@link FileSource}.
 * Pass `displayName` from the document picker (e.g. `file.name`) so native
 * decode can select the correct FFmpeg demuxer for extensionless URIs/paths.
 */
export function toFileSource(
  pathOrUri: string,
  displayName?: string
): FileSource {
  const trimmed = pathOrUri.trim();
  const resolvedName = resolveAudioFileDisplayName(trimmed, displayName);

  if (trimmed.startsWith('content://')) {
    return resolvedName != null
      ? { kind: 'contentUri', uri: trimmed, displayName: resolvedName }
      : { kind: 'contentUri', uri: trimmed };
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
 * - Android: `app:apkAsset`
 * - iOS: `app:appBundle`
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
    base: 'appBundle',
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
      const name =
        'displayName' in source && source.displayName
          ? ` (${source.displayName})`
          : '';
      return `contentUri: ${tail}${name}`;
    }
    case 'securityScoped': {
      const tail =
        source.uri.length > 48 ? `…${source.uri.slice(-40)}` : source.uri;
      const name = source.displayName ? ` (${source.displayName})` : '';
      return `securityScoped: ${tail}${name}`;
    }
    case 'pad':
      return `pad: ${source.packName}/${source.path}`;
    default:
      return 'unknown';
  }
}
