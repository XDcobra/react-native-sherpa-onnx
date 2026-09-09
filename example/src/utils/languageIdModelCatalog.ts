/**
 * Model discovery for Spoken Language Identification (Whisper multilingual).
 * Reuses STT Whisper packs plus any ModelCategory.LanguageId downloads.
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

export type LanguageIdModelEntry = {
  id: string;
  label: string;
  recommended?: boolean;
};

export type LanguageIdCatalogSnapshot = {
  entries: LanguageIdModelEntry[];
  padModelIds: string[];
  padModelsPath: string | null;
  bundledFolders: string[];
  downloadedLanguageIdIds: string[];
  downloadedSttIds: string[];
};

export type LanguageIdModelPathContext = {
  padModelIds: string[];
  padModelsPath: string | null;
  bundledFolders: string[];
  downloadedLanguageIdIds: Set<string>;
  downloadedSttIds: Set<string>;
};

/** Folders suitable for SLID: Whisper multilingual (exclude aishell fine-tunes). */
export function isLanguageIdModelCandidate(
  folder: string,
  hint: string
): boolean {
  const n = folder.toLowerCase();
  if (n.includes('aishell')) return false;
  if (hint === 'languageId' || hint === 'language-id') return true;
  if (n.includes('whisper')) {
    // English-only / non-multilingual naming heuristics
    if (
      n.includes('en-only') ||
      n.includes('english-only') ||
      n.includes('.en.') ||
      n.endsWith('.en') ||
      n.includes('_en_')
    ) {
      return false;
    }
    return true;
  }
  return false;
}

function getModelLabel(model: ModelMeta): string {
  const title = model.displayName?.trim();
  if (title && title.length > 0) return title;
  return getModelDisplayName(model.id);
}

function prioritizeEntries(
  entries: LanguageIdModelEntry[]
): LanguageIdModelEntry[] {
  const unique = Array.from(new Map(entries.map((e) => [e.id, e])).values());
  const tiny = unique.filter((e) => /tiny/i.test(e.id));
  const base = unique.filter(
    (e) => /base/i.test(e.id) && !tiny.some((t) => t.id === e.id)
  );
  const rest = unique
    .filter((e) => !tiny.includes(e) && !base.includes(e))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [
    ...tiny.map((e) => ({ ...e, recommended: true })),
    ...base.map((e) => ({ ...e, recommended: true })),
    ...rest,
  ];
}

export function createLanguageIdModelPathContext(
  snapshot: LanguageIdCatalogSnapshot
): LanguageIdModelPathContext {
  return {
    padModelIds: snapshot.padModelIds,
    padModelsPath: snapshot.padModelsPath,
    bundledFolders: snapshot.bundledFolders,
    downloadedLanguageIdIds: new Set(snapshot.downloadedLanguageIdIds),
    downloadedSttIds: new Set(snapshot.downloadedSttIds),
  };
}

/** Resolve folder id to FileSource for detectLanguageIdModel / createLanguageIdentification. */
export function getLanguageIdModelPathConfig(
  modelId: string,
  ctx: LanguageIdModelPathContext
): FileSource {
  if (ctx.padModelIds.includes(modelId)) {
    return ctx.padModelsPath
      ? getFileModelPath(modelId, ModelCategory.Stt, ctx.padModelsPath)
      : getFileModelPath(modelId, ModelCategory.Stt);
  }
  if (ctx.downloadedLanguageIdIds.has(modelId)) {
    return getFileModelPath(modelId, ModelCategory.LanguageId);
  }
  if (ctx.downloadedSttIds.has(modelId)) {
    return getFileModelPath(modelId, ModelCategory.Stt);
  }
  if (ctx.bundledFolders.includes(modelId)) {
    return getAssetModelPath(modelId);
  }
  return getAssetModelPath(modelId);
}

export async function loadLanguageIdModelCatalog(): Promise<LanguageIdCatalogSnapshot> {
  const assetModels = await listAssetModels();
  const bundledFolders = assetModels
    .filter((m) => isLanguageIdModelCandidate(m.folder, m.hint))
    .map((m) => m.folder);

  const downloadedLanguageId = await listDownloadedModels(
    ModelCategory.LanguageId
  );
  const downloadedStt = await listDownloadedModels(ModelCategory.Stt);
  const downloadedLanguageIdIds = downloadedLanguageId.map((m) => m.id);
  const downloadedSttIds = downloadedStt
    .filter((m) => isLanguageIdModelCandidate(m.id, 'stt'))
    .map((m) => m.id);

  let padIds: string[] = [];
  let padModelsPath: string | null = null;
  try {
    const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
    const fallbackPath = `${DocumentDirectoryPath}/models`;
    const padPath = padPathFromNative ?? fallbackPath;
    const padResults = await listModelsAtPath(padPath);
    padIds = (padResults || [])
      .filter((m) => isLanguageIdModelCandidate(m.folder, m.hint))
      .map((m) => m.folder);
    if (padIds.length > 0) {
      padModelsPath = padPath;
    }
  } catch {
    padIds = [];
  }

  const mergedIds = [
    ...padIds,
    ...bundledFolders.filter((id) => !padIds.includes(id)),
    ...downloadedLanguageIdIds.filter(
      (id) => !padIds.includes(id) && !bundledFolders.includes(id)
    ),
    ...downloadedSttIds.filter(
      (id) =>
        !padIds.includes(id) &&
        !bundledFolders.includes(id) &&
        !downloadedLanguageIdIds.includes(id)
    ),
  ];

  const labelById = new Map<string, string>();
  for (const m of downloadedLanguageId) {
    labelById.set(m.id, getModelLabel(m));
  }
  for (const m of downloadedStt) {
    if (!labelById.has(m.id)) labelById.set(m.id, getModelLabel(m));
  }

  const entries = prioritizeEntries(
    mergedIds.map((id) => ({
      id,
      label: labelById.get(id) ?? getModelDisplayName(id),
    }))
  );

  return {
    entries,
    padModelIds: padIds,
    padModelsPath,
    bundledFolders,
    downloadedLanguageIdIds,
    downloadedSttIds,
  };
}
