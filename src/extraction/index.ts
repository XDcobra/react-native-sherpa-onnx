/**
 * Extraction subpath: list and extract compressed model archives (.tar.zst / .tar.bz2).
 *
 * Entry points:
 *  - listBundledArchives(dirPath)              – filesystem directory (cross-platform)
 *  - listBundledArchivesFromApkAssets(prefix)  – Android APK AssetManager (install-time ship)
 *  - extractArchive(archive, target)           – unified extraction (path or asset-stream)
 *
 * PAD/ODR delivery only provides paths via `getAssetPackPath`; use `listBundledArchives` on that path.
 *
 * After extraction, use listModelsAtPath and `{ kind: 'fs', path }` from the main package.
 */

import { DeviceEventEmitter, Platform } from 'react-native';
import { readDir, stat, exists } from '@dr.pogodin/react-native-fs';
import SherpaOnnx from '../NativeSherpaOnnx';
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
  ExtractArchiveResult,
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
 * Shared by listBundledArchives and listBundledArchivesFromApkAssets.
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

function archivesFromApkAssetPaths(assetPaths: string[]): BundledArchive[] {
  const archives: BundledArchive[] = [];
  for (const archivePath of assetPaths) {
    const filename = archivePath.split('/').pop() ?? archivePath;
    const format = formatFromFilename(filename);
    if (!format) {
      continue;
    }
    archives.push({
      modelId: modelIdFromFilename(filename),
      archivePath,
      format,
      fromAsset: true,
    });
  }
  return archives;
}

// ── Public API ────────────────────────────────────────────────────

/**
 * List `.tar.zst` and `.tar.bz2` under an Android APK asset prefix (e.g. `models`).
 * Install-time ship content merged into the app APK — not tied to PAD pack names.
 */
export async function listBundledArchivesFromApkAssets(
  assetPrefix = 'models'
): Promise<BundledArchive[]> {
  if (Platform.OS !== 'android') {
    return [];
  }
  const listNative = SherpaOnnx.listApkAssetPaths;
  if (typeof listNative !== 'function') {
    return [];
  }
  const assetPaths = await listNative.call(SherpaOnnx, assetPrefix);
  return archivesFromApkAssetPaths(assetPaths);
}

/**
 * List `.tar.zst` and `.tar.bz2` archives in a filesystem directory.
 *
 * Use after PAD/ODR `getAssetPackPath`, main bundle paths, or any directory.
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
 * @param archive    Descriptor from `listBundledArchives` or `listBundledArchivesFromApkAssets`
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
  const skipEntries = options?.skipEntries ?? 0;
  const operationId = options?.operationId ?? archive.archivePath;
  const notification = {
    showNotificationsEnabled: options?.showNotificationsEnabled,
    notificationTitle: options?.notificationTitle,
    notificationText: options?.notificationText,
  };
  const nativeExtra = { skipEntries, operationId };

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
      notification,
      nativeExtra
    );
  }

  return extractTarBz2(
    archive.archivePath,
    targetPath,
    force,
    onProgress,
    signal,
    notification,
    nativeExtra
  );
}

// ── Internal: asset-stream extraction (Android APK_ASSETS) ───────

async function extractFromAsset(
  archive: BundledArchive,
  targetPath: string,
  force: boolean,
  onProgress?: (event: ExtractProgressEvent) => void,
  signal?: AbortSignal,
  notification?: ExtractNotificationArgs,
  nativeExtra?: { skipEntries: number; operationId: string }
): Promise<ExtractResult> {
  const skipEntries = nativeExtra?.skipEntries ?? 0;
  const operationId = nativeExtra?.operationId ?? archive.archivePath;

  let subscription: { remove: () => void } | null = null;
  let removeAbortListener: (() => void) | null = null;

  if (onProgress) {
    subscription = DeviceEventEmitter.addListener(
      'extractArchiveProgress',
      (event: ExtractProgressEvent & { sourcePath?: string }) => {
        if (
          event.sourcePath != null &&
          event.sourcePath !== archive.archivePath
        ) {
          return;
        }
        if (
          event.operationId != null &&
          event.operationId !== '' &&
          event.operationId !== operationId
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
        SherpaOnnx.cancelExtraction(operationId);
      } catch {
        // ignore
      }
    };
    signal.addEventListener('abort', onAbort);
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  }

  try {
    const result = await SherpaOnnx.extractArchiveFromAsset(
      archive.archivePath,
      targetPath,
      force,
      skipEntries,
      operationId,
      notification?.showNotificationsEnabled,
      notification?.notificationTitle,
      notification?.notificationText
    );

    if (!result.success && result.paused) {
      if (signal?.aborted) {
        const err = new Error(result.reason || 'Extraction aborted');
        err.name = 'AbortError';
        throw err;
      }
      return {
        success: false,
        paused: true,
        lastEntryIndex: result.lastEntryIndex,
        lastEntryPath: result.lastEntryPath ?? '',
        bytesExtracted: result.bytesExtracted,
        reason: result.reason,
      };
    }

    if (!result.success) {
      const message = result.reason ?? 'Extraction failed';
      const error = new Error(message);
      if (signal?.aborted || /cancel/i.test(message)) {
        error.name = 'AbortError';
      }
      throw error;
    }
    return {
      success: true,
      path: result.path,
      sha256: result.sha256,
    };
  } finally {
    subscription?.remove();
    removeAbortListener?.();
  }
}
