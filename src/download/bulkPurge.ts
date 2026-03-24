import { exists, unlink } from '@dr.pogodin/react-native-fs';
import { CATEGORY_CONFIG, getArchivePath } from './paths';
import type { ModelCategory, ModelMetaBase } from './types';
import { makeModelOperationKey } from './activeModelOperations';
import { getProtectedModelKeysForBulkDelete } from './protectedModelKeys';
import {
  deleteModelByCategory,
  listDownloadedModelsByCategory,
} from './localModels';
import {
  deleteIncompleteDownload,
  getIncompleteDownloads,
} from './downloadTask';
import {
  deleteIncompleteExtraction,
  getIncompleteExtractions,
} from './modelExtraction';

function allModelCategories(): ModelCategory[] {
  return Object.keys(CATEGORY_CONFIG) as ModelCategory[];
}

export type PurgeDownloadedModelArtifactsResult = {
  deletedComplete: number;
  deletedIncompleteDownloads: number;
  deletedIncompleteExtractions: number;
  skippedProtected: number;
};

/**
 * Deletes completed downloads, incomplete downloads, and incomplete extractions for every
 * {@link ModelCategory}, except keys in `protectKeys` (or current {@link getProtectedModelKeysForBulkDelete}).
 */
export async function purgeDownloadedModelArtifacts(opts?: {
  protectKeys?: ReadonlySet<string>;
}): Promise<PurgeDownloadedModelArtifactsResult> {
  const protect =
    opts?.protectKeys ?? (await getProtectedModelKeysForBulkDelete());
  const result: PurgeDownloadedModelArtifactsResult = {
    deletedComplete: 0,
    deletedIncompleteDownloads: 0,
    deletedIncompleteExtractions: 0,
    skippedProtected: 0,
  };

  const categories = allModelCategories();

  for (const category of categories) {
    const downloaded = await listDownloadedModelsByCategory<ModelMetaBase>(
      category
    );
    for (const m of downloaded) {
      const key = makeModelOperationKey(category, m.id);
      if (protect.has(key)) {
        result.skippedProtected += 1;
        continue;
      }
      await deleteModelByCategory(category, m.id);
      result.deletedComplete += 1;
    }
  }

  for (const category of categories) {
    const incomplete = await getIncompleteDownloads(category);
    for (const s of incomplete) {
      const key = makeModelOperationKey(category, s.modelId);
      if (protect.has(key)) {
        result.skippedProtected += 1;
        continue;
      }
      await deleteIncompleteDownload(category, s.modelId);
      result.deletedIncompleteDownloads += 1;
    }
  }

  for (const category of categories) {
    const extractions = await getIncompleteExtractions(category);
    for (const e of extractions) {
      const key = makeModelOperationKey(category, e.modelId);
      if (protect.has(key)) {
        result.skippedProtected += 1;
        continue;
      }
      await deleteIncompleteExtraction(category, e.modelId);
      try {
        const archivePath = getArchivePath(
          category,
          e.modelId,
          e.model.archiveExt
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
