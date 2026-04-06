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
import {
  type EnsureModelOptions,
  type ModelCategory,
  type EnsureModelResult,
} from './types';

/**
 * Ensure a model is ready locally by handling ready state, resume states,
 * archive-only extraction and full download.
 */
export async function ensureModel(
  category: ModelCategory,
  id: string,
  opts?: EnsureModelOptions
): Promise<EnsureModelResult> {
  const model = await getModelById(category, id);
  if (!model) {
    throw new Error(`Unknown model id: ${id}`);
  }

  const isArchive = model.archiveExt === 'tar.bz2';

  if (opts?.overwrite) {
    await deleteModel(category, id);
    await deleteIncompleteExtraction(category, id);
    await deleteIncompleteDownload(category, id);
  }

  if (!opts?.overwrite && (await isModelDownloaded(category, id))) {
    const localPath = await getModelPath(category, id);
    if (localPath) {
      return {
        modelId: id,
        localPath,
      };
    }
  }

  if (isArchive) {
    const incompleteExtractions = await getIncompleteExtractions(category);
    const extractionState = incompleteExtractions.find(
      (state) => state.modelId === id
    );

    if (extractionState) {
      return resumeExtraction(category, id, {
        onProgress: opts?.onProgress,
        signal: opts?.signal,
        verifyChecksum: opts?.verifyChecksum,
        onChecksumMismatch: opts?.onChecksumMismatch,
        deleteArchiveAfterExtract: opts?.deleteArchiveAfterExtract,
      });
    }
  }

  const incompleteDownloads = await getIncompleteDownloads(category);
  const downloadState = incompleteDownloads.find(
    (state) => state.modelId === id
  );

  if (downloadState) {
    return resumeDownload(category, id, {
      onProgress: opts?.onProgress,
      signal: opts?.signal,
      maxRetries: 0,
      verifyChecksum: opts?.verifyChecksum,
      onChecksumMismatch: opts?.onChecksumMismatch,
      deleteArchiveAfterExtract: opts?.deleteArchiveAfterExtract,
    });
  }

  if (isArchive) {
    const downloadPath = getArchivePath(category, id, model.archiveExt);

    if (await exists(downloadPath)) {
      try {
        const sourceStat = await stat(downloadPath);
        if (model.bytes <= 0 || sourceStat.size >= model.bytes) {
          return extractModel(category, id, {
            onProgress: opts?.onProgress,
            signal: opts?.signal,
            verifyChecksum: opts?.verifyChecksum,
            onChecksumMismatch: opts?.onChecksumMismatch,
            deleteArchiveAfterExtract: opts?.deleteArchiveAfterExtract,
          });
        }
      } catch {
        // fall through to full download
      }
    }
  }

  return downloadModel(category, id, {
    onProgress: opts?.onProgress,
    overwrite: opts?.overwrite ?? false,
    signal: opts?.signal,
    maxRetries: 2,
    verifyChecksum: opts?.verifyChecksum,
    onChecksumMismatch: opts?.onChecksumMismatch,
    deleteArchiveAfterExtract: opts?.deleteArchiveAfterExtract,
  });
}
