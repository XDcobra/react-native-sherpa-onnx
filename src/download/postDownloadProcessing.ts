import {
  exists,
  mkdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from '@dr.pogodin/react-native-fs';
import { extractTarBz2 } from '../extraction/extractTarBz2';
import {
  registerActivePostProcess,
  unregisterActivePostProcess,
} from './activeModelOperations';
import { emitDownloadProgress, emitModelsListUpdated } from './downloadEvents';
import {
  getExtractionStatePath,
  getManifestPath,
  getReadyMarkerPath,
} from './paths';
import {
  type ChecksumMismatchInfo,
  type DownloadResult,
  type ExtractionState,
  type ModelCategory,
  type ModelMeta,
  type Progress,
  type ProgressPhase,
} from './types';
import {
  resolveActualModelDir,
  validateChecksum,
  validateExtractedFiles,
} from './validation';

function extractionProgressPhase(
  skipEntriesTarget: number,
  entryIndex: number | undefined
): ProgressPhase {
  if (
    skipEntriesTarget > 0 &&
    typeof entryIndex === 'number' &&
    entryIndex < skipEntriesTarget
  ) {
    return 'extracting_resume_skipping';
  }
  return 'extracting';
}

async function persistPausedExtractionState(
  extractionStatePath: string,
  params: {
    category: ModelCategory;
    id: string;
    downloadPath: string;
    modelDir: string;
    model: ModelMeta;
    lastEntryIndex: number;
    lastEntryPath: string;
  }
): Promise<void> {
  const {
    category,
    id,
    downloadPath,
    modelDir,
    model,
    lastEntryIndex,
    lastEntryPath,
  } = params;

  let startedAt = new Date().toISOString();
  let effectiveLastEntryIndex = lastEntryIndex;
  let effectiveLastEntryPath = lastEntryPath;
  try {
    if (await exists(extractionStatePath)) {
      const raw = await readFile(extractionStatePath, 'utf8');
      const prev = JSON.parse(raw) as Partial<ExtractionState>;
      if (typeof prev.startedAt === 'string') {
        startedAt = prev.startedAt;
      }
      if (
        effectiveLastEntryIndex < 0 &&
        typeof prev.lastEntryIndex === 'number' &&
        prev.lastEntryIndex >= 0
      ) {
        effectiveLastEntryIndex = prev.lastEntryIndex;
        effectiveLastEntryPath =
          typeof prev.lastEntryPath === 'string' ? prev.lastEntryPath : '';
      }
    }
  } catch {
    // keep defaults
  }

  const doc: ExtractionState = {
    modelId: id,
    category,
    phase: 'extracting',
    startedAt,
    archivePath: downloadPath,
    modelDir,
    model,
    lastEntryIndex: effectiveLastEntryIndex,
    lastEntryPath: effectiveLastEntryPath,
  };

  try {
    await writeFile(extractionStatePath, JSON.stringify(doc), 'utf8');
  } catch {
    // non-fatal; resume may still work from partial native state only in edge cases
  }
}

export type RunPostDownloadProcessingOptions = {
  category: ModelCategory;
  id: string;
  model: ModelMeta;
  downloadPath: string;
  modelDir: string;
  isArchive: boolean;
  statePath: string;
  signal?: AbortSignal;
  verifyChecksum?: boolean;
  onChecksumMismatch?: (issue: ChecksumMismatchInfo) => Promise<boolean>;
  deleteArchiveAfterExtract?: boolean;
  onProgress?: (progress: Progress) => void;
  getDownloadedList: () => Promise<ModelMeta[]>;
  showExtractionNotifications?: boolean;
  extractionNotificationTitle?: string;
  extractionNotificationText?: string;
  extractionOperationId?: string;
  extractionSkipEntries?: number;
};

export async function runPostDownloadProcessing(
  options: RunPostDownloadProcessingOptions
): Promise<DownloadResult> {
  const { category, id, model } = options;
  const sourceId = model.sourceId;

  registerActivePostProcess(category, id, sourceId);

  try {
    return await runPostDownloadProcessingBody(options);
  } finally {
    unregisterActivePostProcess(category, id, sourceId);
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
    verifyChecksum,
    onChecksumMismatch,
    deleteArchiveAfterExtract,
    onProgress,
    getDownloadedList,
    showExtractionNotifications,
    extractionNotificationTitle,
    extractionNotificationText,
    extractionOperationId,
    extractionSkipEntries,
  } = options;

  const isAborted = (): boolean => Boolean(signal?.aborted);
  const sourceId = model.sourceId;

  const createAbortError = (): Error => {
    const abortError = new Error('Operation aborted');
    abortError.name = 'AbortError';
    return abortError;
  };

  if (isAborted()) {
    throw createAbortError();
  }

  let extractResult: {
    success: boolean;
    path?: string;
    sha256?: string;
  } | null = null;
  let extractedTotalBytes = 0;

  if (isArchive) {
    try {
      const archiveStat = await stat(downloadPath);
      if (model.bytes > 0 && archiveStat.size < model.bytes) {
        await unlink(downloadPath);
        throw new Error(
          `Archive file is truncated (${archiveStat.size}/${model.bytes} bytes). Please retry the download.`
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('truncated')) {
        throw error;
      }
    }

    await mkdir(modelDir);

    const extractionStatePath = getExtractionStatePath(category, id, sourceId);
    const isResumeExtract =
      typeof extractionSkipEntries === 'number' && extractionSkipEntries > 0;

    if (!isResumeExtract) {
      try {
        await writeFile(
          extractionStatePath,
          JSON.stringify({
            modelId: id,
            category,
            phase: 'extracting',
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
    }

    const outcome = await extractTarBz2(
      downloadPath,
      modelDir,
      true,
      (event) => {
        if (isAborted()) {
          return;
        }

        if (event.totalBytes > 0) {
          extractedTotalBytes = event.totalBytes;
        }

        const skipTarget = extractionSkipEntries ?? 0;
        const entryIdx = event.entryIndex;
        const progress: Progress = {
          bytesProcessed: event.bytes,
          totalBytes: event.totalBytes,
          percent: event.percent,
          phase: extractionProgressPhase(skipTarget, entryIdx),
          archiveEntryIndex:
            typeof entryIdx === 'number' ? entryIdx : undefined,
        };

        onProgress?.(progress);
        emitDownloadProgress(category, id, progress);
      },
      signal,
      {
        showNotificationsEnabled: showExtractionNotifications !== false,
        notificationTitle: extractionNotificationTitle,
        notificationText: extractionNotificationText,
      },
      {
        operationId: extractionOperationId,
        skipEntries: extractionSkipEntries,
      }
    );

    if (!outcome.success && outcome.paused) {
      await persistPausedExtractionState(extractionStatePath, {
        category,
        id,
        downloadPath,
        modelDir,
        model,
        lastEntryIndex: outcome.lastEntryIndex,
        lastEntryPath: outcome.lastEntryPath,
      });
      throw createAbortError();
    }

    extractResult = outcome;
  }

  const shouldVerifyChecksum = verifyChecksum !== false;
  if (shouldVerifyChecksum && model.sha256) {
    const expectedSha = model.sha256.toLowerCase();
    let issue: ChecksumMismatchInfo | null = null;

    if (isArchive) {
      const actualSha = extractResult?.sha256?.toLowerCase();

      if (!actualSha) {
        issue = {
          category,
          modelId: id,
          filePath: downloadPath,
          expected: model.sha256,
          reason: 'CHECKSUM_FAILED',
        };
      } else if (actualSha !== expectedSha) {
        issue = {
          category,
          modelId: id,
          filePath: downloadPath,
          expected: model.sha256,
          actual: actualSha,
          reason: 'CHECKSUM_MISMATCH',
        };
      }
    } else {
      const checksumResult = await validateChecksum(downloadPath, expectedSha);
      if (!checksumResult.success) {
        issue = {
          category,
          modelId: id,
          filePath: downloadPath,
          expected: model.sha256,
          reason:
            checksumResult.error === 'CHECKSUM_MISMATCH'
              ? 'CHECKSUM_MISMATCH'
              : 'CHECKSUM_FAILED',
        };
      }
    }

    if (issue) {
      const keepFile = onChecksumMismatch
        ? await onChecksumMismatch(issue)
        : false;

      if (!keepFile) {
        if (await exists(modelDir)) {
          await unlink(modelDir);
        }
        if (await exists(downloadPath)) {
          await unlink(downloadPath);
        }
        throw new Error('Checksum verification failed and file was rejected');
      }
    }
  }

  if (isAborted()) {
    throw createAbortError();
  }

  const filesValidation = await validateExtractedFiles(modelDir, category);
  if (!filesValidation.success) {
    await unlink(modelDir);
    throw new Error(
      `Extracted files validation failed: ${
        filesValidation.message ?? 'unknown reason'
      }`
    );
  }

  await writeFile(getReadyMarkerPath(category, id, sourceId), 'ready', 'utf8');

  const now = new Date().toISOString();
  let sizeOnDisk: number | undefined;

  if (isArchive && extractedTotalBytes > 0) {
    sizeOnDisk = extractedTotalBytes;
  } else if (!isArchive) {
    if (model.assets.length > 1) {
      sizeOnDisk = model.assets.reduce(
        (sum, asset) => sum + (asset.bytes ?? 0),
        0
      );
    } else {
      try {
        const sourceStat = await stat(downloadPath);
        sizeOnDisk = sourceStat.size;
      } catch {
        // ignore
      }
    }
  }

  await writeFile(
    getManifestPath(category, id, sourceId),
    JSON.stringify({
      downloadedAt: now,
      lastUsed: now,
      model,
      sizeOnDisk,
    }),
    'utf8'
  );

  try {
    if (await exists(statePath)) {
      await unlink(statePath);
    }
  } catch {
    // non-fatal
  }

  if (isArchive) {
    try {
      const extractionStatePath = getExtractionStatePath(
        category,
        id,
        sourceId
      );
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
      if (await exists(downloadPath)) {
        await unlink(downloadPath);
      }
    } catch (error) {
      console.warn(
        `[Download] Failed to delete archive after extraction for ${category}:${id}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  const list = await getDownloadedList();
  emitModelsListUpdated(category, list);

  const resolvedPath = await resolveActualModelDir(modelDir);
  return {
    modelId: id,
    localPath: resolvedPath,
  };
}
