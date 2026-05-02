/**
 * Save pipeline audio to a user-chosen folder using the SDK’s unified
 * {@link FileDestination} model (same as `react-native-sherpa-onnx/fileio`).
 *
 * - Android: folder picker returns a Storage Access Framework tree (`content://…`);
 *   audio is written with {@link saveAudioAsFile} and `kind: 'contentTree'` — one
 *   native operation, no JS temp file + copy.
 * - iOS / simulators: `file://` directory URIs use `kind: 'fs'`.
 */

import {
  pickDirectory,
  errorCodes,
  isErrorWithCode,
} from '@react-native-documents/picker';
import {
  saveAudioAsFile,
  type AudioSaveInput,
  type AudioOutputFormat,
  type SaveAudioOptions,
} from 'react-native-sherpa-onnx/audio';
import type {
  FileDestination,
  ResolvedFileRef,
} from 'react-native-sherpa-onnx/fileio';

function mimeTypeForAudioFormat(format: AudioOutputFormat): string {
  const f = String(format).toLowerCase();
  switch (f) {
    case 'wav':
      return 'audio/wav';
    case 'mp3':
      return 'audio/mpeg';
    case 'flac':
      return 'audio/flac';
    case 'aac':
    case 'm4a':
      return 'audio/mp4';
    case 'opus':
    case 'ogg':
      return 'audio/ogg';
    case 'webm':
      return 'audio/webm';
    default:
      return 'application/octet-stream';
  }
}

function buildDestination(
  treeOrFolderUri: string,
  filename: string,
  format: AudioOutputFormat
): FileDestination {
  const trimmed = treeOrFolderUri.trim();
  if (trimmed.startsWith('content://')) {
    return {
      kind: 'contentTree',
      treeUri: trimmed,
      filename,
      mimeType: mimeTypeForAudioFormat(format),
    };
  }
  if (trimmed.startsWith('file://')) {
    const dir = decodeURI(trimmed.replace(/^file:\/\//, '')).replace(/\/$/, '');
    return { kind: 'fs', path: `${dir}/${filename}` };
  }
  throw new Error(
    'Unsupported folder URI. Pick a folder with the system picker (expected content:// or file://).'
  );
}

/** True when the user dismissed the directory picker without choosing a folder. */
export function isDirectoryPickCanceled(error: unknown): boolean {
  if (isErrorWithCode(error) && error.code === errorCodes.OPERATION_CANCELED) {
    return true;
  }
  return false;
}

export function formatResolvedLocation(ref: ResolvedFileRef): string {
  return ref.kind === 'contentUri' ? ref.uri : ref.path;
}

/**
 * Opens the system folder picker, then encodes the buffer straight to that
 * location via {@link saveAudioAsFile} (no intermediate copy in JS).
 */
export async function saveAudioToUserPickedFolder(
  input: AudioSaveInput,
  filename: string,
  format: AudioOutputFormat,
  options?: SaveAudioOptions
): Promise<ResolvedFileRef> {
  const picked = await pickDirectory({ requestLongTermAccess: false });
  const uri = picked.uri?.trim();
  if (!uri) {
    throw new Error('Folder picker did not return a URI.');
  }
  const destination = buildDestination(uri, filename, format);
  return saveAudioAsFile(input, destination, format, options);
}
