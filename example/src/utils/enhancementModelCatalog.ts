/**
 * Offline speech enhancement model discovery + path resolution.
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
import { detectEnhancementModel } from 'react-native-sherpa-onnx/enhancement';
import {
  getAssetModelPath,
  getFileModelPath,
  getModelDisplayName,
  toDetectSource,
} from '../modelConfig';
import { RECOMMENDED_MODEL_IDS } from './recommendedModels';
import { isEnhancementFolderHint } from './enhancementCustomInitFill';

const PAD_PACK_NAME = 'sherpa_models';

const RECOMMENDED_ENHANCEMENT_MODEL_IDS =
  RECOMMENDED_MODEL_IDS[ModelCategory.Enhancement] ?? [];

export type EnhancementModelEntry = {
  id: string;
  label: string;
  recommended?: boolean;
};

export type EnhancementCatalogSnapshot = {
  entries: EnhancementModelEntry[];
  padModelIds: string[];
  padModelsPath: string | null;
  bundledFolders: string[];
  downloadedIds: string[];
};

export type EnhancementStreamingCatalogSnapshot = EnhancementCatalogSnapshot & {
  /** Model folder ids where detectEnhancementModel succeeded. */
  detectedModelIds: string[];
  /** Subset of detected models with isStreaming === true. */
  streamingModelIds: string[];
};

export function isEnhancementModelFolder(
  folder: string,
  hint: string
): boolean {
  return isEnhancementFolderHint(folder, hint);
}

function getModelLabel(model: ModelMeta): string {
  const title = model.displayName?.trim();
  if (title && title.length > 0) {
    return title;
  }
  return getModelDisplayName(model.id);
}

function prioritizeEntries(
  entries: EnhancementModelEntry[],
  recommendedIds: string[] = []
): EnhancementModelEntry[] {
  const uniqueEntries = Array.from(
    new Map(entries.map((entry) => [entry.id, entry])).values()
  );
  const recommendedSet = new Set(recommendedIds);
  const recommended: EnhancementModelEntry[] = [];
  const remaining: EnhancementModelEntry[] = [];

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

export type EnhancementModelPathContext = {
  padModelIds: string[];
  padModelsPath: string | null;
  bundledFolders: string[];
  downloadedIds: Set<string>;
};

export function createEnhancementModelPathContext(
  snapshot: EnhancementCatalogSnapshot
): EnhancementModelPathContext {
  return {
    padModelIds: snapshot.padModelIds,
    padModelsPath: snapshot.padModelsPath,
    bundledFolders: snapshot.bundledFolders,
    downloadedIds: new Set(snapshot.downloadedIds),
  };
}

export function getEnhancementModelPathConfig(
  modelId: string,
  ctx: EnhancementModelPathContext
): FileSource {
  if (ctx.padModelIds.includes(modelId)) {
    return ctx.padModelsPath
      ? getFileModelPath(modelId, ModelCategory.Enhancement, ctx.padModelsPath)
      : getFileModelPath(modelId, ModelCategory.Enhancement);
  }
  if (ctx.downloadedIds.has(modelId)) {
    return getFileModelPath(modelId, ModelCategory.Enhancement);
  }
  if (ctx.bundledFolders.includes(modelId)) {
    return getAssetModelPath(modelId);
  }
  return getAssetModelPath(modelId);
}

export async function loadEnhancementModelCatalog(): Promise<EnhancementCatalogSnapshot> {
  const assetModels = await listAssetModels();
  const bundledIds = assetModels
    .filter((model) => isEnhancementModelFolder(model.folder, model.hint))
    .map((model) => model.folder);

  let resolvedPadPath: string | null = null;
  let padIds: string[] = [];
  try {
    const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
    const fallbackPath = `${DocumentDirectoryPath}/models`;
    const basePath = padPathFromNative ?? fallbackPath;
    const padModels = await listModelsAtPath(basePath);
    padIds = (padModels || [])
      .filter((model) => isEnhancementModelFolder(model.folder, model.hint))
      .map((model) => model.folder);
    if (padIds.length > 0) {
      resolvedPadPath = basePath;
    }
  } catch {
    padIds = [];
  }

  const downloaded = await listDownloadedModels(ModelCategory.Enhancement);
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
    RECOMMENDED_ENHANCEMENT_MODEL_IDS
  );

  return {
    entries,
    padModelIds: padIds,
    padModelsPath: resolvedPadPath,
    bundledFolders: bundledIds,
    downloadedIds,
  };
}

export async function loadEnhancementStreamingModelCatalog(): Promise<EnhancementStreamingCatalogSnapshot> {
  const base = await loadEnhancementModelCatalog();
  const ctx = createEnhancementModelPathContext(base);
  const metaById = new Map(
    base.entries.map((entry) => [entry.id, entry] as const)
  );

  const detectedOrdered: string[] = [];
  const streamingIds: string[] = [];

  for (const entry of base.entries) {
    try {
      const modelPath = getEnhancementModelPathConfig(entry.id, ctx);
      const detection = await detectEnhancementModel(
        await toDetectSource(modelPath),
        { modelType: 'auto' }
      );
      if (!detection.success) {
        continue;
      }
      detectedOrdered.push(entry.id);
      if (detection.isStreaming) {
        streamingIds.push(entry.id);
      }
    } catch {
      // Ignore models that cannot be detected.
    }
  }

  const entries = prioritizeEntries(
    detectedOrdered.map((id) => {
      const existing = metaById.get(id);
      return (
        existing ?? {
          id,
          label: getModelDisplayName(id),
        }
      );
    }),
    RECOMMENDED_ENHANCEMENT_MODEL_IDS
  );

  return {
    ...base,
    entries,
    detectedModelIds: detectedOrdered,
    streamingModelIds: streamingIds,
  };
}
