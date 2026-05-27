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
        if (model.bytes <= 0 || sourceStat.size >= model.bytes) {
          return extractModel(category, id, {
            source: modelSourceId,
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
    source: modelSourceId,
    onProgress: opts?.onProgress,
    overwrite: opts?.overwrite ?? false,
    signal: opts?.signal,
    verifyChecksum: opts?.verifyChecksum,
    onChecksumMismatch: opts?.onChecksumMismatch,
    deleteArchiveAfterExtract: opts?.deleteArchiveAfterExtract,
  });
}
