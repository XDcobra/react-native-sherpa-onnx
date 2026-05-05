/**
 * Shared utilities for audio file save operations.
 * Used by {@link AudioSaveDestinationPicker} and feature screens.
 */

import type { ResolvedFileRef } from 'react-native-sherpa-onnx/fileio';

/**
 * Format a resolved file location for display.
 * Extracts the user-friendly path (either filesystem or URI).
 *
 * @param ref - The resolved file reference.
 * @returns A displayable path string.
 */
export function formatResolvedLocation(ref: ResolvedFileRef): string {
  return ref.kind === 'contentUri' ? ref.uri : ref.path;
}

/**
 * Extract just the filename from a full path or URI.
 *
 * @param fullPath - A filesystem path or content:// URI.
 * @returns The filename component.
 */
export function extractFilename(fullPath: string): string {
  const lastSlash = Math.max(
    fullPath.lastIndexOf('/'),
    fullPath.lastIndexOf('\\')
  );
  return lastSlash >= 0 ? fullPath.substring(lastSlash + 1) : fullPath;
}

/**
 * Generate a unique filename by appending a timestamp before the extension.
 *
 * @param baseFilename - The base filename (e.g., "audio.wav").
 * @returns A unique filename (e.g., "audio_1234567890.wav").
 */
export function generateUniqueFilename(baseFilename: string): string {
  const lastDot = baseFilename.lastIndexOf('.');
  if (lastDot === -1) {
    return `${baseFilename}_${Date.now()}`;
  }
  const name = baseFilename.substring(0, lastDot);
  const ext = baseFilename.substring(lastDot);
  return `${name}_${Date.now()}${ext}`;
}
