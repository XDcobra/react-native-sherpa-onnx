import { Platform } from 'react-native';
import {
  CachesDirectoryPath,
  MainBundlePath,
  copyFileAssets,
  exists,
} from '@dr.pogodin/react-native-fs';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';

/**
 * Resolve a FileSource to a URI that React Native `<Image>` can display.
 * Bundled apk/app assets are copied (Android) or resolved from the main
 * bundle (iOS) into a file:// URI.
 */
export async function resolveImageDisplayUri(
  source: FileSource
): Promise<string | null> {
  switch (source.kind) {
    case 'contentUri':
    case 'securityScoped':
      return source.uri;
    case 'fs': {
      const path = source.path.startsWith('/')
        ? source.path
        : `/${source.path}`;
      return path.startsWith('file://') ? path : `file://${path}`;
    }
    case 'app': {
      if (source.base === 'apkAsset' && Platform.OS === 'android') {
        const dest = `${CachesDirectoryPath}/ocr_preview_${source.path.replace(
          /[/\\]/g,
          '_'
        )}`;
        if (!(await exists(dest))) {
          await copyFileAssets(source.path, dest);
        }
        return `file://${dest}`;
      }
      if (source.base === 'appBundle' && MainBundlePath) {
        const path = `${MainBundlePath}/${source.path}`;
        return `file://${path}`;
      }
      return null;
    }
    default:
      return null;
  }
}
