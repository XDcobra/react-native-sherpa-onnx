/**
 * @internal Container format of a document file by content, for the reader's
 * `loadReaderDocument`. Not part of the public document API (callers use the
 * `format` of an extraction result).
 */
import { TurboModuleRegistry } from 'react-native';
import type { Spec } from '../NativeSherpaOnnx';
import type { FileSource } from '../fileio/types';

/** MOBI includes AZW3. */
export type DocumentFileFormat =
  | 'epub'
  | 'fb2'
  | 'mobi'
  | 'cbz'
  | 'cbr'
  | 'pdf';

const FILE_FORMATS: readonly DocumentFileFormat[] = [
  'epub',
  'fb2',
  'mobi',
  'cbz',
  'cbr',
  'pdf',
];

/** Resolves `null` for a file that is none of these formats. */
export async function detectDocumentFormat(
  source: FileSource
): Promise<DocumentFileFormat | null> {
  const raw = await TurboModuleRegistry.getEnforcing<Spec>(
    'SherpaOnnx'
  ).detectDocumentFormat(source as Object);
  return FILE_FORMATS.includes(raw as DocumentFileFormat)
    ? (raw as DocumentFileFormat)
    : null;
}
