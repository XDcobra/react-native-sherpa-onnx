/**
 * Offline source separation model discovery + path resolution.
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
import { isSeparationFolderHint } from './separationCustomInitFill';

const PAD_PACK_NAME = 'sherpa_models';

const RECOMMENDED_SEPARATION_MODEL_IDS =
  RECOMMENDED_MODEL_IDS[ModelCategory.Separation] ?? [];

export type SeparationModelEntry = {
  id: string;
  label: string;
  recommended?: boolean;
};

export type SeparationCatalogSnapshot = {
  entries: SeparationModelEntry[];
  padModelIds: string[];
  padModelsPath: string | null;
  bundledFolders: string[];
  downloadedIds: string[];
};

export function isSeparationModelFolder(folder: string, hint: string): boolean {
  return isSeparationFolderHint(folder, hint);
}

function getModelLabel(model: ModelMeta): string {
  const title = model.displayName?.trim();
  if (title && title.length > 0) {
    return title;
  }
  return getModelDisplayName(model.id);
}

function prioritizeEntries(
  entries: SeparationModelEntry[],
  recommendedIds: string[] = []
): SeparationModelEntry[] {
  const uniqueEntries = Array.from(
    new Map(entries.map((entry) => [entry.id, entry])).values()
  );
  const recommendedSet = new Set(recommendedIds);
  const recommended: SeparationModelEntry[] = [];
  const remaining: SeparationModelEntry[] = [];

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

export type SeparationModelPathContext = {
  padModelIds: string[];
  padModelsPath: string | null;
  bundledFolders: string[];
  downloadedIds: Set<string>;
};

export function createSeparationModelPathContext(
  snapshot: SeparationCatalogSnapshot
): SeparationModelPathContext {
  return {
    padModelIds: snapshot.padModelIds,
    padModelsPath: snapshot.padModelsPath,
    bundledFolders: snapshot.bundledFolders,
    downloadedIds: new Set(snapshot.downloadedIds),
  };
}

export function getSeparationModelPathConfig(
  modelId: string,
  ctx: SeparationModelPathContext
): FileSource {
  if (ctx.padModelIds.includes(modelId)) {
    return ctx.padModelsPath
      ? getFileModelPath(modelId, ModelCategory.Separation, ctx.padModelsPath)
      : getFileModelPath(modelId, ModelCategory.Separation);
  }
  if (ctx.downloadedIds.has(modelId)) {
    return getFileModelPath(modelId, ModelCategory.Separation);
  }
  if (ctx.bundledFolders.includes(modelId)) {
    return getAssetModelPath(modelId);
  }
  return getAssetModelPath(modelId);
}

export async function loadSeparationModelCatalog(): Promise<SeparationCatalogSnapshot> {
  const assetModels = await listAssetModels();
  const bundledIds = assetModels
    .filter((model) => isSeparationModelFolder(model.folder, model.hint))
    .map((model) => model.folder);

  let resolvedPadPath: string | null = null;
  let padIds: string[] = [];
  try {
    const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
    const fallbackPath = `${DocumentDirectoryPath}/models`;
    const basePath = padPathFromNative ?? fallbackPath;
    const padModels = await listModelsAtPath(basePath);
    padIds = (padModels || [])
      .filter((model) => isSeparationModelFolder(model.folder, model.hint))
      .map((model) => model.folder);
    if (padIds.length > 0) {
      resolvedPadPath = basePath;
    }
  } catch {
    padIds = [];
  }

  const downloaded = await listDownloadedModels(ModelCategory.Separation);
  const downloadedIds = downloaded.map((model) => model.id);
  const metaById = new Map(
    downloaded.map((model) => [model.id, model] as const)
  );

  const combinedIds: string[] = [];
  const pushId = (id: string) => {
    if (!combinedIds.includes(id)) {
      combinedIds.push(id);
    }
  };
  for (const id of padIds) {
    pushId(id);
  }
  for (const id of bundledIds) {
    pushId(id);
  }
  for (const id of downloadedIds) {
    pushId(id);
  }

  const entries = prioritizeEntries(
    combinedIds.map((id) => {
      const meta = metaById.get(id);
      return {
        id,
        label: meta ? getModelLabel(meta) : getModelDisplayName(id),
      };
    }),
    RECOMMENDED_SEPARATION_MODEL_IDS
  );

  return {
    entries,
    padModelIds: padIds,
    padModelsPath: resolvedPadPath,
    bundledFolders: bundledIds,
    downloadedIds,
  };
}
