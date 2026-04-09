import SherpaOnnx from '../NativeSherpaOnnx';

/**
 * Save a text file via Android SAF content URI (or a directory path on iOS).
 */
export function saveTextToContentUri(
  text: string,
  directoryUri: string,
  filename: string,
  mimeType = 'text/plain'
): Promise<string> {
  return SherpaOnnx.saveTextToContentUri(
    text,
    directoryUri,
    filename,
    mimeType
  );
}

/**
 * Copy a local file into a document under a SAF directory URI (format-agnostic; Android only).
 * Use for saving converted audio (e.g. MP3, FLAC) to a content URI.
 */
export function copyFileToContentUri(
  filePath: string,
  directoryUri: string,
  filename: string,
  mimeType: string
): Promise<string> {
  return SherpaOnnx.copyFileToContentUri(
    filePath,
    directoryUri,
    filename,
    mimeType
  );
}

/**
 * Copy a SAF content URI to a cache file for local playback (Android: content://; iOS: copies file paths).
 */
export function copyContentUriToCache(
  fileUri: string,
  filename: string
): Promise<string> {
  return SherpaOnnx.copyContentUriToCache(fileUri, filename);
}

/**
 * Share an audio file (file path or content URI).
 */
export function shareAudioFile(
  fileUri: string,
  mimeType = 'audio/wav'
): Promise<void> {
  return SherpaOnnx.shareAudioFile(fileUri, mimeType);
}
