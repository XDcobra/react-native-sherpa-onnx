/**
 * Shared STT model discovery + path resolution (same rules as STTScreen / pipeline screens).
 */

import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
import {
  getAssetPackPath,
  listAssetModels,
  listModelsAtPath,
} from 'react-native-sherpa-onnx/utils';
import {
  listDownloadedModels,
  ModelCategory,
  type ModelMeta,
} from 'react-native-sherpa-onnx/download';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import {
  getAssetModelPath,
  getFileModelPath,
  getModelDisplayName,
} from '../modelConfig';
import { RECOMMENDED_MODEL_IDS } from './recommendedModels';

const PAD_PACK_NAME = 'sherpa_models';

const RECOMMENDED_STT_MODEL_IDS =
  RECOMMENDED_MODEL_IDS[ModelCategory.Stt] ?? [];

export type SttModelEntry = {
  id: string;
  label: string;
  recommended?: boolean;
};

export type SttCatalogSnapshot = {
  entries: SttModelEntry[];
  padModelIds: string[];
  padModelsPath: string | null;
  bundledSttFolders: string[];
  downloadedSttIds: string[];
};

function getModelLabel(model: ModelMeta): string {
  const title = model.displayName?.trim();
  if (title && title.length > 0) {
    return title;
  }
  return getModelDisplayName(model.id);
}

function prioritizeEntries(
  entries: SttModelEntry[],
  recommendedIds: string[] = []
): SttModelEntry[] {
  const uniqueEntries = Array.from(
    new Map(entries.map((entry) => [entry.id, entry])).values()
  );
  const recommendedSet = new Set(recommendedIds);
  const recommended: SttModelEntry[] = [];
  const remaining: SttModelEntry[] = [];

  for (const entry of uniqueEntries) {
    if (recommendedSet.has(entry.id)) {
      recommended.push({ ...entry, recommended: true });
      continue;
    }
    remaining.push(entry);
  }

  recommended.sort(
    (left, right) =>
      recommendedIds.indexOf(left.id) - recommendedIds.indexOf(right.id)
  );
  remaining.sort((left, right) => left.label.localeCompare(right.label));

  return [...recommended, ...remaining];
}

export type SttModelPathContext = {
  padModelIds: string[];
  padModelsPath: string | null;
  bundledFolders: string[];
  downloadedIds: Set<string>;
};

/** Resolve a discovered folder id to the FileSource shape used by detectSttModel / createSTT. */
export function getSttModelPathConfig(
  modelId: string,
  ctx: SttModelPathContext
): FileSource {
  if (ctx.padModelIds.includes(modelId)) {
    return ctx.padModelsPath
      ? getFileModelPath(modelId, ModelCategory.Stt, ctx.padModelsPath)
      : getFileModelPath(modelId, ModelCategory.Stt);
  }
  if (ctx.downloadedIds.has(modelId)) {
    return getFileModelPath(modelId, ModelCategory.Stt);
  }
  if (ctx.bundledFolders.includes(modelId)) {
    return getAssetModelPath(modelId);
  }
  return getAssetModelPath(modelId);
}

export function createSttModelPathContext(
  snapshot: SttCatalogSnapshot
): SttModelPathContext {
  return {
    padModelIds: snapshot.padModelIds,
    padModelsPath: snapshot.padModelsPath,
    bundledFolders: snapshot.bundledSttFolders,
    downloadedIds: new Set(snapshot.downloadedSttIds),
  };
}

export async function loadSttModelCatalog(): Promise<SttCatalogSnapshot> {
  const assetModels = await listAssetModels();
  const bundledIds = assetModels
    .filter((model) => model.hint === 'stt')
    .map((model) => model.folder);
  const downloadedModels = await listDownloadedModels(ModelCategory.Stt);
  const downloadedIds = downloadedModels.map((model) => model.id);

  let padIds: string[] = [];
  let padModelsPath: string | null = null;
  try {
    const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
    const fallbackPath = `${DocumentDirectoryPath}/models`;
    const padPath = padPathFromNative ?? fallbackPath;
    const padResults = await listModelsAtPath(padPath);
    padIds = (padResults || [])
      .filter((model) => model.hint === 'stt')
      .map((model) => model.folder);
    if (padIds.length > 0) {
      padModelsPath = padPath;
    }
  } catch {
    padIds = [];
  }

  const mergedIds = [
    ...padIds,
    ...bundledIds.filter((id) => !padIds.includes(id)),
    ...downloadedIds.filter(
      (id) => !padIds.includes(id) && !bundledIds.includes(id)
    ),
  ];

  const entries = prioritizeEntries(
    mergedIds.map((id) => {
      const downloaded = downloadedModels.find((model) => model.id === id);
      return {
        id,
        label: downloaded ? getModelLabel(downloaded) : getModelDisplayName(id),
      };
    }),
    RECOMMENDED_STT_MODEL_IDS
  );

  return {
    entries,
    padModelIds: padIds,
    padModelsPath,
    bundledSttFolders: bundledIds,
    downloadedSttIds: downloadedIds,
  };
}
