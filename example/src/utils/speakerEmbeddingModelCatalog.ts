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

const PAD_PACK_NAME = 'sherpa_models';

export const RECOMMENDED_SPEAKER_EMBEDDING_IDS = [
  '3dspeaker_speech_eres2net_large_sv_zh-cn_3dspeaker_16k',
  '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k',
  'wespeaker_en_voxceleb_CAM++',
  'sherpa-onnx-wespeaker-voxceleb-resnet34',
];

export type SpeakerEmbeddingModelEntry = {
  id: string;
  label: string;
  recommended?: boolean;
};

export type SpeakerEmbeddingCatalogSnapshot = {
  entries: SpeakerEmbeddingModelEntry[];
  padModelIds: string[];
  padModelsPath: string | null;
  bundledFolders: string[];
  downloadedIds: string[];
  downloadedPaths?: Record<string, string>;
};

export function isSpeakerEmbeddingFolder(
  folder: string,
  hint?: string
): boolean {
  if (hint === 'speaker-identification' || hint === 'speaker_embedding') {
    return true;
  }
  const f = folder.toLowerCase();
  return (
    f.includes('wespeaker') ||
    f.includes('eres2net') ||
    f.includes('cam++') ||
    f.includes('3dspeaker') ||
    f.includes('titanet') ||
    f.includes('speaker-embedding')
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
  entries: SpeakerEmbeddingModelEntry[],
  recommendedIds: string[] = []
): SpeakerEmbeddingModelEntry[] {
  const uniqueEntries = Array.from(
    new Map(entries.map((entry) => [entry.id, entry])).values()
  );
  const recommendedSet = new Set(recommendedIds);
  const recommended: SpeakerEmbeddingModelEntry[] = [];
  const remaining: SpeakerEmbeddingModelEntry[] = [];

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

export function getSpeakerEmbeddingModelPathConfig(
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
      ? getFileModelPath(
          modelId,
          ModelCategory.SpeakerEmbedding,
          ctx.padModelsPath
        )
      : getFileModelPath(modelId, ModelCategory.SpeakerEmbedding);
  }
  if (ctx.downloadedIds.has(modelId)) {
    const exactPath = ctx.downloadedPaths?.[modelId];
    if (exactPath) {
      return { kind: 'fs', path: exactPath };
    }
    return getFileModelPath(modelId, ModelCategory.SpeakerEmbedding);
  }
  if (ctx.bundledFolders.includes(modelId)) {
    return getAssetModelPath(modelId);
  }
  return getAssetModelPath(modelId);
}

export async function loadSpeakerEmbeddingModelCatalog(): Promise<SpeakerEmbeddingCatalogSnapshot> {
  const assetModels = await listAssetModels().catch(() => []);
  const bundledIds = assetModels
    .filter((model) => isSpeakerEmbeddingFolder(model.folder, model.hint))
    .map((model) => model.folder);

  let resolvedPadPath: string | null = null;
  let padIds: string[] = [];
  try {
    const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
    const fallbackPath = `${DocumentDirectoryPath}/models`;
    const basePath = padPathFromNative ?? fallbackPath;
    const padModels = await listModelsAtPath(basePath);
    padIds = (padModels || [])
      .filter((model) => isSpeakerEmbeddingFolder(model.folder, model.hint))
      .map((model) => model.folder);
    if (padIds.length > 0) {
      resolvedPadPath = basePath;
    }
  } catch {
    padIds = [];
  }

  const downloaded = await listDownloadedModels(
    ModelCategory.SpeakerEmbedding
  ).catch(() => []);
  const downloadedIds = downloaded.map((model) => model.id);
  const downloadedPaths: Record<string, string> = {};
  for (const m of downloaded) {
    try {
      const resolved = await getModelPath(
        ModelCategory.SpeakerEmbedding,
        m.id,
        {
          source: m.sourceId,
        }
      );
      if (resolved) {
        downloadedPaths[m.id] = resolved;
      }
    } catch {
      // fallback
    }
  }

  const metaById = new Map(
    downloaded.map((model) => [model.id, model] as const)
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
    RECOMMENDED_SPEAKER_EMBEDDING_IDS
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
