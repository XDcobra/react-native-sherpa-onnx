import { exists, unlink } from '@dr.pogodin/react-native-fs';
import { makeModelOperationKey } from './activeModelOperations';
import {
  deleteIncompleteDownload,
  getIncompleteDownloads,
} from './downloadTask';
import { deleteModel, listDownloadedModels } from './localModels';
import {
  deleteIncompleteExtraction,
  getIncompleteExtractions,
} from './modelExtraction';
import { getArchivePath } from './paths';
import { getProtectedKeys } from './protectedModelKeys';
import { ModelCategory } from './types';

export type PurgeAllResult = {
  deletedComplete: number;
  deletedIncompleteDownloads: number;
  deletedIncompleteExtractions: number;
  skippedProtected: number;
};

function allModelCategories(): ModelCategory[] {
  return Object.values(ModelCategory);
}

/**
 * Deletes completed and incomplete artifacts across all categories,
 * except keys in `protectKeys`.
 */
export async function purgeAll(opts?: {
  protectKeys?: ReadonlySet<string>;
}): Promise<PurgeAllResult> {
  const protect = opts?.protectKeys ?? (await getProtectedKeys());

  const result: PurgeAllResult = {
    deletedComplete: 0,
    deletedIncompleteDownloads: 0,
    deletedIncompleteExtractions: 0,
    skippedProtected: 0,
  };

  const categories = allModelCategories();

  for (const category of categories) {
    const downloaded = await listDownloadedModels(category);

    for (const model of downloaded) {
      const key = makeModelOperationKey(category, model.id);
      if (protect.has(key)) {
        result.skippedProtected += 1;
        continue;
      }

      await deleteModel(category, model.id);
      result.deletedComplete += 1;
    }
  }

  for (const category of categories) {
    const incomplete = await getIncompleteDownloads(category);

    for (const state of incomplete) {
      const key = makeModelOperationKey(category, state.modelId);
      if (protect.has(key)) {
        result.skippedProtected += 1;
        continue;
      }

      await deleteIncompleteDownload(category, state.modelId);
      result.deletedIncompleteDownloads += 1;
    }
  }

  for (const category of categories) {
    const extractions = await getIncompleteExtractions(category);

    for (const extraction of extractions) {
      const key = makeModelOperationKey(category, extraction.modelId);
      if (protect.has(key)) {
        result.skippedProtected += 1;
        continue;
      }

      await deleteIncompleteExtraction(category, extraction.modelId);

      try {
        const archivePath = getArchivePath(
          category,
          extraction.modelId,
          extraction.model.archiveExt
        );
        if (await exists(archivePath)) {
          await unlink(archivePath);
        }
      } catch {
        // non-fatal
      }

      result.deletedIncompleteExtractions += 1;
    }
  }

  return result;
}
