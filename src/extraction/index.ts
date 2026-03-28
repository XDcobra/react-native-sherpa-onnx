/**
 * Extraction subpath: list and extract compressed model archives (.tar.zst / .tar.bz2).
 *
 * Three entry points:
 *  - getBundledArchives(packName)    – Android PAD packs (STORAGE_FILES or APK_ASSETS)
 *  - listBundledArchives(dirPath)    – any filesystem directory (cross-platform)
 *  - extractArchive(archive, target) – unified extraction (auto-selects path or asset-stream)
 *
 * After extraction, use listModelsAtPath / autoModelPath from the main package.
 */

import { DeviceEventEmitter, Platform } from 'react-native';
import { readDir, stat, exists } from '@dr.pogodin/react-native-fs';
import SherpaOnnx from '../NativeSherpaOnnx';
import { extractTarZst } from './extractTarZst';
import { extractTarBz2 } from './extractTarBz2';
import type {
  BundledArchive,
  ExtractArchiveOptions,
  ExtractNotificationArgs,
  ExtractResult,
  ExtractProgressEvent,
} from './types';

export type {
  BundledArchive,
  ExtractArchiveOptions,
  ExtractNotificationArgs,
  ExtractResult,
  ExtractProgressEvent,
} from './types';

// ── Constants & helpers ───────────────────────────────────────────

const TAR_ZST = '.tar.zst';
const TAR_BZ2 = '.tar.bz2';

function formatFromFilename(name: string): 'tar.zst' | 'tar.bz2' | null {
  if (name.endsWith(TAR_ZST)) return 'tar.zst';
  if (name.endsWith(TAR_BZ2)) return 'tar.bz2';
  return null;
}

function modelIdFromFilename(filename: string): string {
  if (filename.endsWith(TAR_ZST)) return filename.slice(0, -TAR_ZST.length);
  if (filename.endsWith(TAR_BZ2)) return filename.slice(0, -TAR_BZ2.length);
  return filename;
}

/**
 * Scan a filesystem directory for .tar.zst / .tar.bz2 entries.
 * Shared by getBundledArchives (STORAGE_FILES) and listBundledArchives.
 */
async function scanDirectoryForArchives(
  directoryPath: string
): Promise<BundledArchive[]> {
  const dirExists = await exists(directoryPath);
  if (!dirExists) return [];

  const entries = await readDir(directoryPath);
  const archives: BundledArchive[] = [];

  for (const entry of entries) {
    const format = formatFromFilename(entry.name);
    if (!format || !entry.isFile()) continue;

    let fileSize = 0;
    try {
      const s = await stat(entry.path);
      fileSize = s.size ?? 0;
    } catch {
      // stat may fail on some filesystems; fileSize stays 0
    }

    archives.push({
      modelId: modelIdFromFilename(entry.name),
      archivePath: entry.path,
      format,
      fileSize,
    });
  }

  return archives;
}

// ── Public API ────────────────────────────────────────────────────

/**
 * List compressed archives delivered via a **Play Asset Delivery** pack.
 *
 * - **STORAGE_FILES** packs: scans the pack directory on the filesystem.
 * - **APK_ASSETS** packs: queries the Android AssetManager for embedded archive paths.
 *   Archives returned with `fromAsset: true` are extracted by streaming from the APK
 *   (no temp copy needed).
 * - **iOS / unavailable pack**: returns `null`.
 *
 * @param packName  Name of the PAD asset pack (e.g. `"sherpa_models"`)
 */
export async function getBundledArchives(
  packName: string
): Promise<BundledArchive[] | null> {
  if (Platform.OS !== 'android') {
    return null;
  }

  const packPath = await SherpaOnnx.getAssetPackPath(packName);

  if (packPath != null && packPath.length > 0) {
    const archives = await scanDirectoryForArchives(packPath);
    return archives.length > 0 ? archives : null;
  }

  const assetPaths = await SherpaOnnx.listBundledArchiveAssetPaths(packName);
  if (assetPaths.length === 0) return null;

  return assetPaths.map((archivePath) => {
    const filename = archivePath.split('/').pop() ?? archivePath;
    const format = formatFromFilename(filename) ?? 'tar.zst';
    return {
      modelId: modelIdFromFilename(filename),
      archivePath,
      format,
      fromAsset: true,
    };
  });
}

/**
 * List `.tar.zst` and `.tar.bz2` archives in a filesystem directory.
 *
 * Works on **all platforms** — use for:
 * - iOS main-bundle archives (`MainBundlePath + '/models'`)
 * - Archives downloaded to the documents directory
 * - Any other folder containing compressed model archives
 *
 * @param directoryPath  Absolute path to the directory to scan
 */
export async function listBundledArchives(
  directoryPath: string
): Promise<BundledArchive[]> {
  return scanDirectoryForArchives(directoryPath);
}

/**
 * Extract a single archive to the target directory.
 *
 * Handles both source types transparently:
 * - **Filesystem archives** (from `listBundledArchives` or PAD STORAGE_FILES) —
 *   uses the regular path-based extraction.
 * - **APK asset archives** (`fromAsset: true`, from PAD APK_ASSETS) —
 *   streams directly from the APK without copying the archive to disk first.
 *
 * @param archive    Descriptor returned by `getBundledArchives` or `listBundledArchives`
 * @param targetPath Directory to extract into (e.g. `DocumentDirectoryPath + '/models'`)
 * @param options    `force` (default `true`), `onProgress`, `signal` (AbortSignal)
 */
export async function extractArchive(
  archive: BundledArchive,
  targetPath: string,
  options?: ExtractArchiveOptions
): Promise<ExtractResult> {
  const force = options?.force !== false;
  const onProgress = options?.onProgress;
  const signal = options?.signal;
  const notification = {
    showNotificationsEnabled: options?.showNotificationsEnabled,
    notificationTitle: options?.notificationTitle,
    notificationText: options?.notificationText,
  };

  if (signal?.aborted) {
    const err = new Error('Extraction aborted');
    err.name = 'AbortError';
    throw err;
  }

  const useAssetStream =
    Platform.OS === 'android' &&
    (archive.fromAsset === true ||
      archive.archivePath.startsWith('asset_packs/'));

  if (useAssetStream) {
    return extractFromAsset(
      archive,
      targetPath,
      force,
      onProgress,
      signal,
      notification
    );
  }

  if (archive.format === 'tar.zst') {
    return extractTarZst(
      archive.archivePath,
      targetPath,
      force,
      onProgress,
      signal,
      notification
    );
  }
  return extractTarBz2(
    archive.archivePath,
    targetPath,
    force,
    onProgress,
    signal,
    notification
  );
}

// ── Internal: asset-stream extraction (Android APK_ASSETS) ───────

async function extractFromAsset(
  archive: BundledArchive,
  targetPath: string,
  force: boolean,
  onProgress?: (event: ExtractProgressEvent) => void,
  signal?: AbortSignal,
  notification?: ExtractNotificationArgs
): Promise<ExtractResult> {
  const eventName =
    archive.format === 'tar.zst'
      ? 'extractTarZstProgress'
      : 'extractTarBz2Progress';

  let subscription: { remove: () => void } | null = null;
  let removeAbortListener: (() => void) | null = null;

  if (onProgress) {
    subscription = DeviceEventEmitter.addListener(
      eventName,
      (event: ExtractProgressEvent & { sourcePath?: string }) => {
        if (
          event.sourcePath != null &&
          event.sourcePath !== archive.archivePath
        ) {
          return;
        }
        const safePercent = Math.max(0, Math.min(100, event.percent));
        onProgress({ ...event, percent: safePercent });
      }
    );
  }

  if (signal) {
    const onAbort = () => {
      try {
        SherpaOnnx.cancelExtractBySourcePath(archive.archivePath);
      } catch {
        // ignore
      }
    };
    signal.addEventListener('abort', onAbort);
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  }

  try {
    const result =
      archive.format === 'tar.zst'
        ? await SherpaOnnx.extractTarZstFromAsset(
            archive.archivePath,
            targetPath,
            force,
            notification?.showNotificationsEnabled,
            notification?.notificationTitle,
            notification?.notificationText
          )
        : await SherpaOnnx.extractTarBz2FromAsset(
            archive.archivePath,
            targetPath,
            force,
            notification?.showNotificationsEnabled,
            notification?.notificationTitle,
            notification?.notificationText
          );

    if (!result.success) {
      const message = result.reason ?? 'Extraction failed';
      const error = new Error(message);
      if (signal?.aborted || /cancel/i.test(message)) {
        error.name = 'AbortError';
      }
      throw error;
    }
    return result;
  } finally {
    subscription?.remove();
    removeAbortListener?.();
  }
}
