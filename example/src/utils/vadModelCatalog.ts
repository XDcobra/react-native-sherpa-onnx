/**
 * Shared VAD model discovery + path resolution (same rules as Segmentation showcase).
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
import type { ModelPathConfig } from 'react-native-sherpa-onnx/fileio';
import {
  getAssetModelPath,
  getFileModelPath,
  getModelDisplayName,
} from '../modelConfig';
import { RECOMMENDED_MODEL_IDS } from './recommendedModels';

const PAD_PACK_NAME = 'sherpa_models';

const RECOMMENDED_VAD_MODEL_IDS =
  RECOMMENDED_MODEL_IDS[ModelCategory.Vad] ?? [];

export type VadModelEntry = {
  id: string;
  label: string;
  recommended?: boolean;
};

export type VadCatalogSnapshot = {
  entries: VadModelEntry[];
  padVadModelIds: string[];
  padModelsPath: string | null;
  bundledVadFolders: string[];
  downloadedVadIds: string[];
};

export function isVadModelFolder(folder: string, hint: string): boolean {
  if (hint === 'vad') {
    return true;
  }
  const normalized = folder.toLowerCase();
  return (
    normalized.includes('vad') ||
    normalized.includes('silero') ||
    normalized.includes('ten-vad')
  );
}

function getModelLabel(model: ModelMeta): string {
  const title = model.displayName?.trim();
  if (title && title.length > 0) {
    return title;
  }
  return getModelDisplayName(model.id);
}

function prioritizeEntries(
  entries: VadModelEntry[],
  recommendedIds: string[] = []
): VadModelEntry[] {
  const uniqueEntries = Array.from(
    new Map(entries.map((entry) => [entry.id, entry])).values()
  );
  const recommendedSet = new Set(recommendedIds);
  const recommended: VadModelEntry[] = [];
  const remaining: VadModelEntry[] = [];

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

/**
 * Resolve a discovered folder id to the same ModelPathConfig shape used by detectVadModel.
 */
export function getVadModelPathConfig(
  modelId: string,
  ctx: {
    padModelIds: string[];
    padModelsPath: string | null;
    bundledFolders: string[];
    downloadedIds: Set<string>;
  }
): ModelPathConfig {
  if (ctx.padModelIds.includes(modelId)) {
    return ctx.padModelsPath
      ? getFileModelPath(modelId, ModelCategory.Vad, ctx.padModelsPath)
      : getFileModelPath(modelId, ModelCategory.Vad);
  }
  if (ctx.downloadedIds.has(modelId)) {
    return getFileModelPath(modelId, ModelCategory.Vad);
  }
  if (ctx.bundledFolders.includes(modelId)) {
    return getAssetModelPath(modelId);
  }
  return getAssetModelPath(modelId);
}

export async function loadVadModelCatalog(): Promise<VadCatalogSnapshot> {
  const assetModels = await listAssetModels();
  const bundledIds = assetModels
    .filter((model) => isVadModelFolder(model.folder, model.hint))
    .map((model) => model.folder);

  let resolvedPadPath: string | null = null;
  let padIds: string[] = [];
  try {
    const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
    const fallbackPath = `${DocumentDirectoryPath}/models`;
    const basePath = padPathFromNative ?? fallbackPath;
    const padModels = await listModelsAtPath(basePath);
    padIds = (padModels || [])
      .filter((model) => isVadModelFolder(model.folder, model.hint))
      .map((model) => model.folder);
    if (padIds.length > 0) {
      resolvedPadPath = basePath;
    }
  } catch {
    padIds = [];
  }

  const downloaded = await listDownloadedModels(ModelCategory.Vad);
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
    RECOMMENDED_VAD_MODEL_IDS
  );

  return {
    entries,
    padVadModelIds: padIds,
    padModelsPath: resolvedPadPath,
    bundledVadFolders: bundledIds,
    downloadedVadIds: downloadedIds,
  };
}
