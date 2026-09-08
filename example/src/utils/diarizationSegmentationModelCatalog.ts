/**
 * Shared pyannote/reverb segmentation-pack discovery for speech_pyannote_segmentation.
 */

import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
import {
  getAssetPackPath,
  listAssetModels,
  listModelsAtPath,
} from 'react-native-sherpa-onnx/utils';
import {
  getModelPath,
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

const RECOMMENDED_DIARIZATION_SEG_IDS = [
  'sherpa-onnx-pyannote-segmentation-3-0',
  ...(RECOMMENDED_MODEL_IDS[ModelCategory.Diarization] ?? []),
];

export type DiarizationSegmentationModelEntry = {
  id: string;
  label: string;
  recommended?: boolean;
};

export type DiarizationSegmentationCatalogSnapshot = {
  entries: DiarizationSegmentationModelEntry[];
  padModelIds: string[];
  padModelsPath: string | null;
  bundledFolders: string[];
  downloadedIds: string[];
  downloadedPaths?: Record<string, string>;
};

/**
 * Same shape as Enhancement / Separation / VAD screen filters:
 * exact category hint first, then known pack-family tokens in the folder id.
 */
export function isDiarizationSegmentationFolder(
  folder: string,
  hint?: string
): boolean {
  const normalized = folder.toLowerCase();
  if (normalized.includes('sortformer') || normalized.includes('streaming')) {
    return false;
  }
  if (hint === 'diarization') {
    return true;
  }
  return (
    normalized.includes('pyannote') ||
    normalized.includes('reverb') ||
    normalized.includes('segmentation') ||
    normalized.includes('diarization')
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
  entries: DiarizationSegmentationModelEntry[],
  recommendedIds: string[] = []
): DiarizationSegmentationModelEntry[] {
  const uniqueEntries = Array.from(
    new Map(entries.map((entry) => [entry.id, entry])).values()
  );
  const recommendedSet = new Set(recommendedIds);
  const recommended: DiarizationSegmentationModelEntry[] = [];
  const remaining: DiarizationSegmentationModelEntry[] = [];

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

export function getDiarizationSegmentationModelPathConfig(
  modelId: string,
  ctx: {
    padModelIds: string[];
    padModelsPath: string | null;
    bundledFolders: string[];
    downloadedIds: Set<string>;
    downloadedPaths?: Record<string, string>;
  }
): FileSource {
  if (ctx.padModelIds.includes(modelId)) {
    return ctx.padModelsPath
      ? getFileModelPath(modelId, ModelCategory.Diarization, ctx.padModelsPath)
      : getFileModelPath(modelId, ModelCategory.Diarization);
  }
  if (ctx.downloadedIds.has(modelId)) {
    const exactPath = ctx.downloadedPaths?.[modelId];
    if (exactPath) {
      return { kind: 'fs', path: exactPath };
    }
    return getFileModelPath(modelId, ModelCategory.Diarization);
  }
  if (ctx.bundledFolders.includes(modelId)) {
    return getAssetModelPath(modelId);
  }
  return getAssetModelPath(modelId);
}

export async function loadDiarizationSegmentationModelCatalog(): Promise<DiarizationSegmentationCatalogSnapshot> {
  const assetModels = await listAssetModels().catch(() => []);
  const bundledIds = assetModels
    .filter((model) =>
      isDiarizationSegmentationFolder(model.folder, model.hint)
    )
    .map((model) => model.folder);

  let resolvedPadPath: string | null = null;
  let padIds: string[] = [];
  try {
    const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
    const fallbackPath = `${DocumentDirectoryPath}/models`;
    const basePath = padPathFromNative ?? fallbackPath;
    const padModels = await listModelsAtPath(basePath);
    padIds = (padModels || [])
      .filter((model) =>
        isDiarizationSegmentationFolder(model.folder, model.hint)
      )
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
  const segDownloaded = downloaded.filter((model) =>
    isDiarizationSegmentationFolder(model.id)
  );
  const downloadedIds = segDownloaded.map((model) => model.id);
  const downloadedPaths: Record<string, string> = {};
  for (const m of segDownloaded) {
    try {
      const resolved = await getModelPath(ModelCategory.Diarization, m.id, {
        source: m.sourceId,
      });
      if (resolved) {
        downloadedPaths[m.id] = resolved;
      }
    } catch {
      // fallback
    }
  }

  const metaById = new Map(
    segDownloaded.map((model) => [model.id, model] as const)
  );

  const combinedIds: string[] = [];
  const pushId = (id: string) => {
    if (!combinedIds.includes(id)) {
      combinedIds.push(id);
    }
  };
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
    RECOMMENDED_DIARIZATION_SEG_IDS
  );

  return {
    entries,
    padModelIds: padIds,
    padModelsPath: resolvedPadPath,
    bundledFolders: bundledIds,
    downloadedIds,
    downloadedPaths,
  };
}
