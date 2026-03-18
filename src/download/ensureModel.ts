import { exists, stat } from '@dr.pogodin/react-native-fs';
import type {
  ModelCategory,
  ModelMetaBase,
  ChecksumIssue,
  DownloadProgress,
} from './types';
import type { DownloadResult } from './types';
import { getArchivePath } from './paths';
import { getModelByIdByCategory } from './registry';
import {
  isModelDownloadedByCategory,
  getLocalModelPathByCategory,
  deleteModelByCategory,
} from './localModels';
import { downloadModelByCategory } from './downloadTask';
import { getIncompleteDownloads, resumeDownload } from './downloadTask';
import {
  getIncompleteExtractions,
  resumeExtraction,
  extractModelByCategory,
  deleteIncompleteExtraction,
} from './modelExtraction';
import { deleteIncompleteDownload } from './downloadTask';

export type EnsureModelOptions = {
  /** Progress callback (percent, phase, speed, eta). */
  onProgress?: (progress: DownloadProgress) => void;
  /** AbortController signal to cancel download or extraction. */
  signal?: AbortSignal;
  /** If true, remove existing model and any incomplete state, then download/extract from scratch. */
  overwrite?: boolean;
  /** Called on checksum mismatch; return true to keep the file. */
  onChecksumIssue?: (issue: ChecksumIssue) => Promise<boolean>;
  /** For archive models: if true (default), delete the archive after extraction to save space. */
  deleteArchiveAfterExtract?: boolean;
};

/**
 * Single entry point to ensure a model is available locally: handles download, extraction,
 * and all edge cases (already ready, incomplete download, incomplete extraction, archive
 * already present). Call this with category, id, and optional opts; the function decides
 * whether to return the existing path, resume an interrupted operation, or start download/extraction.
 *
 * Use this as the main API when you only need "make this model ready"; the lower-level
 * APIs (downloadModelByCategory, resumeDownload, extractModelByCategory, getIncompleteExtractions,
 * etc.) remain available for advanced flows.
 */
export async function ensureModelByCategory<T extends ModelMetaBase>(
  category: ModelCategory,
  id: string,
  opts?: EnsureModelOptions
): Promise<DownloadResult> {
  const model = await getModelByIdByCategory<T>(category, id);
  if (!model) {
    throw new Error(`Unknown model id: ${id}`);
  }

  const isArchive = model.archiveExt === 'tar.bz2';

  if (opts?.overwrite) {
    await deleteModelByCategory(category, id);
    await deleteIncompleteExtraction(category, id);
    await deleteIncompleteDownload(category, id);
  }

  if (!opts?.overwrite && (await isModelDownloadedByCategory(category, id))) {
    const localPath = await getLocalModelPathByCategory(category, id);
    if (localPath) {
      return { modelId: id, localPath };
    }
  }

  if (isArchive) {
    const incompleteExtractions = await getIncompleteExtractions(category);
    const extractionState = incompleteExtractions.find((s) => s.modelId === id);
    if (extractionState) {
      return resumeExtraction<T>(category, id, {
        onProgress: opts?.onProgress,
        signal: opts?.signal,
        onChecksumIssue: opts?.onChecksumIssue,
        deleteArchiveAfterExtract: opts?.deleteArchiveAfterExtract,
      });
    }
  }

  const incompleteDownloads = await getIncompleteDownloads(category);
  const downloadState = incompleteDownloads.find((s) => s.modelId === id);
  if (downloadState) {
    return resumeDownload<T>(category, id, {
      onProgress: opts?.onProgress,
      signal: opts?.signal,
      onChecksumIssue: opts?.onChecksumIssue,
      deleteArchiveAfterExtract: opts?.deleteArchiveAfterExtract,
    });
  }

  if (isArchive) {
    const downloadPath = getArchivePath(category, id, model.archiveExt);
    if (await exists(downloadPath)) {
      try {
        const st = await stat(downloadPath);
        if (model.bytes <= 0 || (st.size != null && st.size >= model.bytes)) {
          return extractModelByCategory<T>(category, id, {
            onProgress: opts?.onProgress,
            signal: opts?.signal,
            onChecksumIssue: opts?.onChecksumIssue,
            deleteArchiveAfterExtract: opts?.deleteArchiveAfterExtract,
          });
        }
      } catch {
        // fall through to download
      }
    }
  }

  return downloadModelByCategory<T>(category, id, {
    onProgress: opts?.onProgress,
    overwrite: opts?.overwrite ?? false,
    signal: opts?.signal,
    onChecksumIssue: opts?.onChecksumIssue,
    deleteArchiveAfterExtract: opts?.deleteArchiveAfterExtract,
  });
}
