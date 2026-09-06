/**
 * Streaming Diarization model discovery for NeMo Sortformer.
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

export const RECOMMENDED_DIARIZATION_STREAMING_IDS = [
  'diar_streaming_sortformer_4spk-v2.1',
];

export type DiarizationStreamingModelEntry = {
  id: string;
  label: string;
  recommended?: boolean;
};

export type DiarizationStreamingCatalogSnapshot = {
  entries: DiarizationStreamingModelEntry[];
  padModelIds: string[];
  padModelsPath: string | null;
  bundledFolders: string[];
  downloadedIds: string[];
};

export function isDiarizationStreamingFolder(
  folder: string,
  hint?: string
): boolean {
  if (hint === 'diarization_streaming' || hint === 'sortformer') {
    return true;
  }
  const normalized = folder.toLowerCase();
  return (
    normalized.includes('sortformer') || normalized.includes('diar_streaming')
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
  entries: DiarizationStreamingModelEntry[],
  recommendedIds: string[] = []
): DiarizationStreamingModelEntry[] {
  const uniqueEntries = Array.from(
    new Map(entries.map((entry) => [entry.id, entry])).values()
  );
  const recommendedSet = new Set(recommendedIds);
  const recommended: DiarizationStreamingModelEntry[] = [];
  const remaining: DiarizationStreamingModelEntry[] = [];

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

export function getDiarizationStreamingModelPathConfig(
  modelId: string,
  ctx: {
    padModelIds: string[];
    padModelsPath: string | null;
    bundledFolders: string[];
    downloadedIds: Set<string>;
  }
): FileSource {
  if (ctx.padModelIds.includes(modelId)) {
    return ctx.padModelsPath
      ? getFileModelPath(modelId, ModelCategory.Diarization, ctx.padModelsPath)
      : getFileModelPath(modelId, ModelCategory.Diarization);
  }
  if (ctx.downloadedIds.has(modelId)) {
    return getFileModelPath(modelId, ModelCategory.Diarization);
  }
  if (ctx.bundledFolders.includes(modelId)) {
    return getAssetModelPath(modelId);
  }
  return getAssetModelPath(modelId);
}

export async function loadDiarizationStreamingModelCatalog(): Promise<DiarizationStreamingCatalogSnapshot> {
  const assetModels = await listAssetModels().catch(() => []);
  const bundledIds = assetModels
    .filter((model) => isDiarizationStreamingFolder(model.folder, model.hint))
    .map((model) => model.folder);

  let resolvedPadPath: string | null = null;
  let padIds: string[] = [];
  try {
    const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
    const fallbackPath = `${DocumentDirectoryPath}/models`;
    const basePath = padPathFromNative ?? fallbackPath;
    const padModels = await listModelsAtPath(basePath);
    padIds = (padModels || [])
      .filter((model) => isDiarizationStreamingFolder(model.folder, model.hint))
      .map((model) => model.folder);
    if (padIds.length > 0) {
      resolvedPadPath = basePath;
    }
  } catch {
    padIds = [];
  }

  const downloaded = await listDownloadedModels(
    ModelCategory.Diarization
  ).catch(() => []);
  const streamingDownloaded = downloaded.filter(
    (m) =>
      m.isStreaming === true ||
      m.modelType === 'sortformer' ||
      isDiarizationStreamingFolder(m.id)
  );

  const downloadedIds = streamingDownloaded.map((model) => model.id);
  const metaById = new Map(
    streamingDownloaded.map((model) => [model.id, model] as const)
  );

  const combinedIds: string[] = [];
  const pushId = (id: string) => {
    if (!combinedIds.includes(id)) {
      combinedIds.push(id);
    }
  };
  for (const id of RECOMMENDED_DIARIZATION_STREAMING_IDS) {
    pushId(id);
  }
  for (const id of downloadedIds) {
    pushId(id);
  }
  for (const id of padIds) {
    pushId(id);
  }
  for (const id of bundledIds) {
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
    RECOMMENDED_DIARIZATION_STREAMING_IDS
  );

  return {
    entries,
    padModelIds: padIds,
    padModelsPath: resolvedPadPath,
    bundledFolders: bundledIds,
    downloadedIds,
  };
}
