import { Platform } from 'react-native';
import {
  CachesDirectoryPath,
  copyFileAssets,
  exists,
} from '@dr.pogodin/react-native-fs';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { fileSourceFromBundledPath } from './fileSourceFromUri';

/**
 * EPUB/FB2 extract rejects Android apkAsset (D19). Copy once to cache and
 * return a seekable filesystem source. PDFs keep the bundled FileSource.
 */
export async function materializeBundledDocumentSource(
  relativePath: string
): Promise<FileSource> {
  if (Platform.OS !== 'android') {
    return fileSourceFromBundledPath(relativePath);
  }
  const dest = `${CachesDirectoryPath}/edoc_${relativePath.replace(
    /[/\\]/g,
    '_'
  )}`;
  if (!(await exists(dest))) {
    await copyFileAssets(relativePath, dest);
  }
  return { kind: 'fs', path: dest };
}
