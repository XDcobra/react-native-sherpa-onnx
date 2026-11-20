import { exists, stat } from '@dr.pogodin/react-native-fs';
import {
  deleteIncompleteDownload,
  downloadModel,
  getIncompleteDownloads,
  resumeDownload,
} from './downloadTask';
import { deleteModel, getModelPath, isModelDownloaded } from './localModels';
import {
  deleteIncompleteExtraction,
  extractModel,
  getIncompleteExtractions,
  resumeExtraction,
} from './modelExtraction';
import { getArchivePath } from './paths';
import { getModelById } from './registry';
import { DOWNLOAD_ERROR_CODES, isDownloadError } from './sources/errors';
import { getArchiveBytes, repairMissingSupplements } from './supplementFiles';
import {
  PauseError,
  type EnsureModelOptions,
  type ModelCategory,
  type EnsureModelResult,
} from './types';

/**
 * Ensure a model is ready locally by handling ready state, resume states,
 * archive-only extraction and full download. A model that is already installed but
 * lacks a supplement file its catalog entry lists (see `ModelMeta.supplements`) gets
 * just that file downloaded. That repair is best effort: when it fails (for example
 * offline), the installed model is returned as it is and the next call tries again;
 * only a cancel or pause through `signal` is thrown.
 *
 * @throws {DownloadError} `DOWNLOAD_UNKNOWN_SOURCE` — `source` is not registered.
 * @throws {DownloadError} `DOWNLOAD_NETWORK_FAILED` — transport failed before an HTTP status.
 * @throws {DownloadError} `DOWNLOAD_HTTP_STATUS` — server returned a non-success status.
 * @throws {DownloadError} `DOWNLOAD_CANCELLED` — `signal` aborted.
 * @throws {DownloadError} `DOWNLOAD_SOURCE_AUTH_FAILED` — source rejected credentials (401/403).
 * @throws {DownloadError} `DOWNLOAD_EXTRACT_UNSUPPORTED_FORMAT` — archive format is not supported.
 * @throws {DownloadError} `DOWNLOAD_INVALID_LAYOUT` — archive/folder asset layout is invalid.
 * @throws {DownloadError} `DOWNLOAD_INTEGRITY_CHECKSUM_MISMATCH` — downloaded bytes did not match the expected checksum.
 * @throws {PauseError} — download or extraction was paused.
 */
export async function ensureModel(
  category: ModelCategory,
  id: string,
  opts?: EnsureModelOptions
): Promise<EnsureModelResult> {
  const sourceId = opts?.source ?? 'default';

  const model = await getModelById(category, id, {
    source: sourceId,
  });
  if (!model) {
    throw new Error(`Unknown model id: ${id}`);
  }

  const modelSourceId = model.sourceId;

  const isArchive = model.layout.kind === 'archive';

  if (opts?.overwrite) {
    await deleteModel(category, id, modelSourceId);
    await deleteIncompleteExtraction(category, id, modelSourceId);
    await deleteIncompleteDownload(category, id, modelSourceId);
  }

  if (
    !opts?.overwrite &&
    (await isModelDownloaded(category, id, { source: modelSourceId }))
  ) {
    const localPath = await getModelPath(category, id, {
      source: modelSourceId,
    });
    if (localPath) {
      // Fetch files the catalog now lists but this download predates (for example an
      // English lexicon added after the pack was installed).
      try {
        await repairMissingSupplements({
          category,
          model,
          sourceId: modelSourceId,
          targetDir: localPath,
          signal: opts?.signal,
          verifyChecksum: opts?.verifyChecksum,
          onChecksumMismatch: opts?.onChecksumMismatch,
          onProgress: opts?.onProgress,
        });
      } catch (error) {
        // The model worked before the catalog listed the file, so a failed repair
        // must not make it unusable (offline, server error).
        if (isRepairStop(error, opts?.signal)) throw error;
      }
      return {
        modelId: id,
        localPath,
      };
    }
  }

  if (isArchive) {
    const incompleteExtractions = await getIncompleteExtractions(category, {
      source: modelSourceId,
    });
    const extractionState = incompleteExtractions.find(
      (state) => state.modelId === id
    );

    if (extractionState) {
      return resumeExtraction(category, id, {
        source: modelSourceId,
        onProgress: opts?.onProgress,
        signal: opts?.signal,
        verifyChecksum: opts?.verifyChecksum,
        onChecksumMismatch: opts?.onChecksumMismatch,
        deleteArchiveAfterExtract: opts?.deleteArchiveAfterExtract,
        showExtractionNotifications: opts?.showExtractionNotifications,
      });
    }
  }

  const incompleteDownloads = await getIncompleteDownloads(category, {
    source: modelSourceId,
  });
  const downloadState = incompleteDownloads.find(
    (state) => state.modelId === id
  );

  if (downloadState) {
    return resumeDownload(category, id, {
      source: modelSourceId,
      onProgress: opts?.onProgress,
      signal: opts?.signal,
      verifyChecksum: opts?.verifyChecksum,
      onChecksumMismatch: opts?.onChecksumMismatch,
      deleteArchiveAfterExtract: opts?.deleteArchiveAfterExtract,
      showExtractionNotifications: opts?.showExtractionNotifications,
    });
  }

  if (isArchive) {
    const downloadPath = getArchivePath(
      category,
      id,
      model.layout,
      model.assets,
      modelSourceId
    );

    if (await exists(downloadPath)) {
      try {
        const sourceStat = await stat(downloadPath);
        const archiveBytes = getArchiveBytes(model);
        if (archiveBytes <= 0 || sourceStat.size >= archiveBytes) {
          return extractModel(category, id, {
            source: modelSourceId,
            onProgress: opts?.onProgress,
            signal: opts?.signal,
            verifyChecksum: opts?.verifyChecksum,
            onChecksumMismatch: opts?.onChecksumMismatch,
            deleteArchiveAfterExtract: opts?.deleteArchiveAfterExtract,
            showExtractionNotifications: opts?.showExtractionNotifications,
          });
        }
      } catch {
        // fall through to full download
      }
    }
  }

  return downloadModel(category, id, {
    source: modelSourceId,
    onProgress: opts?.onProgress,
    overwrite: opts?.overwrite ?? false,
    signal: opts?.signal,
    verifyChecksum: opts?.verifyChecksum,
    onChecksumMismatch: opts?.onChecksumMismatch,
    deleteArchiveAfterExtract: opts?.deleteArchiveAfterExtract,
    showExtractionNotifications: opts?.showExtractionNotifications,
  });
}

function isRepairStop(
  error: unknown,
  signal: AbortSignal | undefined
): boolean {
  if (signal?.aborted) return true;
  if (error instanceof PauseError) return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  return (
    isDownloadError(error) && error.code === DOWNLOAD_ERROR_CODES.CANCELLED
  );
}
