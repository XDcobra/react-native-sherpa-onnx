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
      const sourceId = model.sourceId;
      const key = makeModelOperationKey(category, model.id, sourceId);
      if (protect.has(key)) {
        result.skippedProtected += 1;
        continue;
      }

      await deleteModel(category, model.id, sourceId);
      result.deletedComplete += 1;
    }
  }

  for (const category of categories) {
    const downloaded = await listDownloadedModels(category);
    const sourceIds = new Set<string>(
      downloaded.map((model) => model.sourceId)
    );
    sourceIds.add('default');

    for (const sourceId of sourceIds) {
      const incomplete = await getIncompleteDownloads(category, {
        source: sourceId,
      });

      for (const state of incomplete) {
        const key = makeModelOperationKey(category, state.modelId, sourceId);
        if (protect.has(key)) {
          result.skippedProtected += 1;
          continue;
        }

        await deleteIncompleteDownload(category, state.modelId, sourceId);
        result.deletedIncompleteDownloads += 1;
      }
    }
  }

  for (const category of categories) {
    const downloaded = await listDownloadedModels(category);
    const sourceIds = new Set<string>(
      downloaded.map((model) => model.sourceId)
    );
    sourceIds.add('default');

    for (const sourceId of sourceIds) {
      const extractions = await getIncompleteExtractions(category, {
        source: sourceId,
      });

      for (const extraction of extractions) {
        const effectiveSourceId = extraction.model.sourceId ?? sourceId;
        const key = makeModelOperationKey(
          category,
          extraction.modelId,
          effectiveSourceId
        );
        if (protect.has(key)) {
          result.skippedProtected += 1;
          continue;
        }

        await deleteIncompleteExtraction(
          category,
          extraction.modelId,
          effectiveSourceId
        );

        try {
          const archivePath = getArchivePath(
            category,
            extraction.modelId,
            extraction.model.layout,
            extraction.model.assets,
            effectiveSourceId
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
  }

  return result;
}
