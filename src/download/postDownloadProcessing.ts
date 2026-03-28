import {
  exists,
  mkdir,
  writeFile,
  stat,
  unlink,
} from '@dr.pogodin/react-native-fs';
import type {
  ModelCategory,
  ModelMetaBase,
  ModelManifest,
  ChecksumIssue,
  DownloadProgress,
} from './types';
import {
  getReadyMarkerPath,
  getManifestPath,
  getExtractionStatePath,
} from './paths';
import {
  validateChecksum,
  validateExtractedFiles,
  resolveActualModelDir,
} from './validation';
import { extractTarBz2 } from '../extraction/extractTarBz2';
import { promptChecksumFallback } from './checksumPrompt';
import { emitDownloadProgress, emitModelsListUpdated } from './downloadEvents';
import type { DownloadResult } from './types';
import {
  registerActivePostProcess,
  unregisterActivePostProcess,
} from './activeModelOperations';

export type RunPostDownloadProcessingOptions = {
  category: ModelCategory;
  id: string;
  model: ModelMetaBase;
  downloadPath: string;
  modelDir: string;
  isArchive: boolean;
  statePath: string;
  signal?: AbortSignal;
  onChecksumIssue?: (issue: ChecksumIssue) => Promise<boolean>;
  deleteArchiveAfterExtract?: boolean;
  onProgress?: (progress: DownloadProgress) => void;
  /**
   * **Android:** Native extraction progress notification (default true), aligned with the download-manager flow.
   * **iOS:** No effect.
   */
  showExtractionNotifications?: boolean;
  /** **Android:** Optional notification title (default: SDK/native default title). */
  extractionNotificationTitle?: string;
  /** **Android:** Optional notification body prefix (progress percent is appended natively). */
  extractionNotificationText?: string;
  /** Called to get current list of downloaded models for emitModelsListUpdated. */
  getDownloadedList: () => Promise<ModelMetaBase[]>;
};

export async function runPostDownloadProcessing(
  options: RunPostDownloadProcessingOptions
): Promise<DownloadResult> {
  const {
    category,
    id,
    model,
    downloadPath,
    modelDir,
    isArchive,
    statePath,
    signal,
    onChecksumIssue,
    deleteArchiveAfterExtract,
    onProgress,
    getDownloadedList,
    showExtractionNotifications,
    extractionNotificationTitle,
    extractionNotificationText,
  } = options;

  registerActivePostProcess(category, id);
  try {
    return await runPostDownloadProcessingBody({
      category,
      id,
      model,
      downloadPath,
      modelDir,
      isArchive,
      statePath,
      signal,
      onChecksumIssue,
      deleteArchiveAfterExtract,
      onProgress,
      getDownloadedList,
      showExtractionNotifications,
      extractionNotificationTitle,
      extractionNotificationText,
    });
  } finally {
    unregisterActivePostProcess(category, id);
  }
}

async function runPostDownloadProcessingBody(
  options: RunPostDownloadProcessingOptions
): Promise<DownloadResult> {
  const {
    category,
    id,
    model,
    downloadPath,
    modelDir,
    isArchive,
    statePath,
    signal,
    onChecksumIssue,
    deleteArchiveAfterExtract,
    onProgress,
    getDownloadedList,
    showExtractionNotifications,
    extractionNotificationTitle,
    extractionNotificationText,
  } = options;

  const isAborted = () => Boolean(signal?.aborted);
  const abortError = new Error('Download aborted');
  abortError.name = 'AbortError';

  if (signal?.aborted) throw abortError;

  let extractResult: { sha256?: string } | null = null;
  let extractedTotalBytes = 0;

  if (isArchive) {
    try {
      const archiveStat = await stat(downloadPath);
      if (model.bytes > 0 && archiveStat.size < model.bytes) {
        console.warn(
          `[Download] Archive truncated for ${category}:${id}: ${archiveStat.size}/${model.bytes} bytes. Deleting for re-download.`
        );
        await unlink(downloadPath);
        throw new Error(
          `Archive file is truncated (${archiveStat.size}/${model.bytes} bytes). Please retry the download.`
        );
      }
    } catch (statErr) {
      if (statErr instanceof Error && statErr.message.includes('truncated'))
        throw statErr;
    }
    await mkdir(modelDir);
    const extractionStatePath = getExtractionStatePath(category, id);
    try {
      await writeFile(
        extractionStatePath,
        JSON.stringify({
          modelId: id,
          category,
          phase: 'extracting' as const,
          startedAt: new Date().toISOString(),
          archivePath: downloadPath,
          modelDir,
          model,
        }),
        'utf8'
      );
    } catch {
      // non-fatal; resume after crash may not be possible for this run
    }
    extractResult = await extractTarBz2(
      downloadPath,
      modelDir,
      true,
      (evt) => {
        if (isAborted()) return;
        if (evt.totalBytes > 0) extractedTotalBytes = evt.totalBytes;
        const progress: DownloadProgress = {
          bytesDownloaded: evt.bytes,
          totalBytes: evt.totalBytes,
          percent: evt.percent,
          phase: 'extracting',
        };
        onProgress?.(progress);
        emitDownloadProgress(category, id, progress);
      },
      signal,
      {
        showNotificationsEnabled: showExtractionNotifications !== false,
        notificationTitle: extractionNotificationTitle,
        notificationText: extractionNotificationText,
      }
    );
  }

  if (model.sha256) {
    const expectedSha = model.sha256.toLowerCase();
    let issue: ChecksumIssue | null = null;
    if (isArchive) {
      const nativeSha = extractResult?.sha256?.toLowerCase();
      if (!nativeSha) {
        issue = {
          category,
          id,
          archivePath: downloadPath,
          expected: model.sha256,
          message: 'Native SHA-256 not available after extraction.',
          reason: 'CHECKSUM_FAILED',
        };
      } else if (nativeSha !== expectedSha) {
        issue = {
          category,
          id,
          archivePath: downloadPath,
          expected: model.sha256,
          message: `Checksum mismatch: expected ${model.sha256}, got ${extractResult?.sha256}`,
          reason: 'CHECKSUM_MISMATCH',
        };
      }
    } else {
      const checksumResult = await validateChecksum(downloadPath, expectedSha);
      if (!checksumResult.success) {
        issue = {
          category,
          id,
          archivePath: downloadPath,
          expected: model.sha256,
          message: checksumResult.message ?? 'Checksum validation failed.',
          reason:
            checksumResult.error === 'CHECKSUM_MISMATCH'
              ? 'CHECKSUM_MISMATCH'
              : 'CHECKSUM_FAILED',
        };
      }
    }
    if (issue) {
      const keepFile = onChecksumIssue
        ? await onChecksumIssue(issue)
        : await promptChecksumFallback(issue);
      if (!keepFile) {
        if (await exists(modelDir)) await unlink(modelDir);
        if (await exists(downloadPath)) await unlink(downloadPath);
        throw new Error(`Checksum validation failed: ${issue.message}`);
      }
    }
  }

  if (signal?.aborted) throw abortError;

  const filesValidation = await validateExtractedFiles(modelDir, category);
  if (!filesValidation.success) {
    await unlink(modelDir);
    throw new Error(
      `Extracted files validation failed: ${filesValidation.message}`
    );
  }

  await writeFile(getReadyMarkerPath(category, id), 'ready', 'utf8');
  const now = new Date().toISOString();
  let sizeOnDisk: number | undefined;
  if (isArchive && extractedTotalBytes > 0) {
    sizeOnDisk = extractedTotalBytes;
  } else if (!isArchive) {
    try {
      const s = await stat(downloadPath);
      sizeOnDisk = s.size;
    } catch {
      // ignore
    }
  }
  await writeFile(
    getManifestPath(category, id),
    JSON.stringify({
      downloadedAt: now,
      lastUsed: now,
      model,
      sizeOnDisk,
    } as ModelManifest),
    'utf8'
  );

  try {
    if (await exists(statePath)) await unlink(statePath);
  } catch {
    // non-fatal
  }
  if (isArchive) {
    try {
      const extractionStatePath = getExtractionStatePath(category, id);
      if (
        extractionStatePath !== statePath &&
        (await exists(extractionStatePath))
      ) {
        await unlink(extractionStatePath);
      }
    } catch {
      // non-fatal
    }
  }

  if (isArchive && deleteArchiveAfterExtract !== false) {
    try {
      if (await exists(downloadPath)) await unlink(downloadPath);
    } catch (err) {
      console.warn(
        `[Download] Failed to delete archive after extraction for ${category}:${id}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  const list = await getDownloadedList();
  emitModelsListUpdated(category, list);

  const resolvedPath = await resolveActualModelDir(modelDir);
  return { modelId: id, localPath: resolvedPath };
}
