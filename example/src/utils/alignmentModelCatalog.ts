/**
 * Shared alignment (wav2vec2) model discovery + path resolution.
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

const PAD_PACK_NAME = 'sherpa_models';

export type AlignmentModelEntry = {
  id: string;
  label: string;
  recommended?: boolean;
};

export type AlignmentCatalogSnapshot = {
  entries: AlignmentModelEntry[];
  padModelIds: string[];
  padModelsPath: string | null;
  bundledAlignmentFolders: string[];
  downloadedAlignmentIds: string[];
};

export function isAlignmentModelFolder(folder: string, hint: string): boolean {
  if (hint === 'alignment') {
    return true;
  }
  return folder.toLowerCase().includes('wav2vec');
}

function getModelLabel(model: ModelMeta): string {
  const title = model.displayName?.trim();
  if (title && title.length > 0) {
    return title;
  }
  return getModelDisplayName(model.id);
}

function prioritizeEntries(
  entries: AlignmentModelEntry[]
): AlignmentModelEntry[] {
  const uniqueEntries = Array.from(
    new Map(entries.map((entry) => [entry.id, entry])).values()
  );
  return uniqueEntries.sort((left, right) =>
    left.label.localeCompare(right.label)
  );
}

export type AlignmentModelPathContext = {
  padModelIds: string[];
  padModelsPath: string | null;
  bundledFolders: string[];
  downloadedIds: Set<string>;
};

export function createAlignmentModelPathContext(
  snapshot: AlignmentCatalogSnapshot
): AlignmentModelPathContext {
  return {
    padModelIds: snapshot.padModelIds,
    padModelsPath: snapshot.padModelsPath,
    bundledFolders: snapshot.bundledAlignmentFolders,
    downloadedIds: new Set(snapshot.downloadedAlignmentIds),
  };
}

export function getAlignmentModelPathConfig(
  modelId: string,
  ctx: AlignmentModelPathContext
): FileSource {
  if (ctx.padModelIds.includes(modelId)) {
    return ctx.padModelsPath
      ? getFileModelPath(modelId, ModelCategory.Alignment, ctx.padModelsPath)
      : getFileModelPath(modelId, ModelCategory.Alignment);
  }
  if (ctx.downloadedIds.has(modelId)) {
    return getFileModelPath(modelId, ModelCategory.Alignment);
  }
  if (ctx.bundledFolders.includes(modelId)) {
    return getAssetModelPath(modelId);
  }
  return getAssetModelPath(modelId);
}

export async function loadAlignmentModelCatalog(): Promise<AlignmentCatalogSnapshot> {
  const assetModels = await listAssetModels();
  const bundledIds = assetModels
    .filter((model) => isAlignmentModelFolder(model.folder, model.hint))
    .map((model) => model.folder);

  let resolvedPadPath: string | null = null;
  let padIds: string[] = [];
  try {
    const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
    const fallbackPath = `${DocumentDirectoryPath}/models`;
    const basePath = padPathFromNative ?? fallbackPath;
    const padModels = await listModelsAtPath(basePath);
    padIds = (padModels || [])
      .filter((model) => isAlignmentModelFolder(model.folder, model.hint))
      .map((model) => model.folder);
    if (padIds.length > 0) {
      resolvedPadPath = basePath;
    }
  } catch {
    padIds = [];
  }

  const downloaded = await listDownloadedModels(ModelCategory.Alignment);
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
    })
  );

  return {
    entries,
    padModelIds: padIds,
    padModelsPath: resolvedPadPath,
    bundledAlignmentFolders: bundledIds,
    downloadedAlignmentIds: downloadedIds,
  };
}
