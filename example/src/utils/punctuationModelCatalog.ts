/**
 * Punctuation model discovery (same rules as PunctuationScreen / Segmentation showcase).
 * Only folders that pass offline CT-Transformer detection are listed.
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
import { detectPunctuationModel } from 'react-native-sherpa-onnx/punctuation';
import {
  getAssetModelPath,
  getFileModelPath,
  getModelDisplayName,
  toDetectSource,
} from '../modelConfig';

const PAD_PACK_NAME = 'sherpa_models';

export type PunctuationModelEntry = {
  id: string;
  label: string;
};

export type PunctuationCatalogSnapshot = {
  entries: PunctuationModelEntry[];
  padPunctuationModelIds: string[];
  padModelsPath: string | null;
  bundledPunctuationFolders: string[];
  downloadedPunctuationIds: string[];
};

export function isPunctuationNameCandidate(folder: string): boolean {
  const f = folder.toLowerCase();
  return (
    f.includes('punct') ||
    f.includes('punctuation') ||
    f.includes('ct-transform') ||
    f.includes('ct_transformer')
  );
}

export function isStreamingPunctuationNameCandidate(folder: string): boolean {
  const f = folder.toLowerCase();
  return (
    f.includes('punct') ||
    f.includes('punctuation') ||
    f.includes('cnn-bilstm') ||
    f.includes('cnn_bilstm')
  );
}

function getModelLabel(meta: ModelMeta | undefined, id: string): string {
  if (meta) {
    const title = meta.displayName?.trim();
    if (title && title.length > 0) {
      return title;
    }
  }
  return getModelDisplayName(id);
}

async function folderIsOfflineCtTransformer(
  modelPath: FileSource
): Promise<boolean> {
  try {
    const d = await detectPunctuationModel(await toDetectSource(modelPath), {
      modelType: 'ct_transformer',
    });
    return d.success && d.modelType === 'ct_transformer';
  } catch {
    return false;
  }
}

async function folderIsStreamingCnnBilstm(
  modelPath: FileSource
): Promise<boolean> {
  try {
    const d = await detectPunctuationModel(await toDetectSource(modelPath), {
      modelType: 'cnn_bilstm',
    });
    return d.success && d.modelType === 'cnn_bilstm' && d.isStreaming === true;
  } catch {
    return false;
  }
}

export type PunctuationModelPathContext = {
  padModelIds: string[];
  padModelsPath: string | null;
  bundledFolders: string[];
  downloadedIds: Set<string>;
};

export function createPunctuationModelPathContext(
  snapshot: PunctuationCatalogSnapshot
): PunctuationModelPathContext {
  return {
    padModelIds: snapshot.padPunctuationModelIds,
    padModelsPath: snapshot.padModelsPath,
    bundledFolders: snapshot.bundledPunctuationFolders,
    downloadedIds: new Set(snapshot.downloadedPunctuationIds),
  };
}

/**
 * Resolve a discovered folder id to FileSource (matches PunctuationScreen).
 */
export function getPunctuationModelPathConfig(
  modelId: string,
  ctx: PunctuationModelPathContext
): FileSource {
  if (ctx.downloadedIds.has(modelId)) {
    return getFileModelPath(modelId, ModelCategory.Punctuation);
  }
  if (ctx.padModelIds.includes(modelId) && ctx.padModelsPath) {
    return getFileModelPath(
      modelId,
      ModelCategory.Punctuation,
      ctx.padModelsPath
    );
  }
  if (ctx.bundledFolders.includes(modelId)) {
    return getAssetModelPath(modelId);
  }
  return getAssetModelPath(modelId);
}

export async function loadPunctuationModelCatalog(): Promise<PunctuationCatalogSnapshot> {
  const [assetModels, downloadedList] = await Promise.all([
    listAssetModels(),
    listDownloadedModels(ModelCategory.Punctuation),
  ]);

  const fromAssets = assetModels
    .map((m) => m.folder)
    .filter(isPunctuationNameCandidate);
  const downloadedIds = downloadedList.map((m) => m.id);
  const metaById = new Map(downloadedList.map((m) => [m.id, m] as const));

  let padFolders: string[] = [];
  let resolvedPadPath: string | null = null;
  try {
    const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
    const fallback = `${DocumentDirectoryPath}/models`;
    const base = padPathFromNative ?? fallback;
    const atPath = await listModelsAtPath(base);
    padFolders = (atPath || [])
      .map((m) => m.folder)
      .filter(isPunctuationNameCandidate);
    if (padFolders.length > 0) {
      resolvedPadPath = base;
    }
  } catch {
    padFolders = [];
  }

  const combined = Array.from(
    new Set([
      ...downloadedIds,
      ...fromAssets,
      ...padFolders.filter(
        (f) => !downloadedIds.includes(f) && !fromAssets.includes(f)
      ),
    ])
  );

  const ctxBase = {
    padModelIds: padFolders,
    padModelsPath: resolvedPadPath,
    bundledFolders: fromAssets,
    downloadedIds: new Set(downloadedIds),
  };

  const ok: PunctuationModelEntry[] = [];
  for (const folder of combined) {
    const mp = getPunctuationModelPathConfig(folder, ctxBase);
    if (await folderIsOfflineCtTransformer(mp)) {
      ok.push({
        id: folder,
        label: getModelLabel(metaById.get(folder), folder),
      });
    }
  }

  ok.sort((a, b) => a.label.localeCompare(b.label));

  return {
    entries: ok,
    padPunctuationModelIds: padFolders,
    padModelsPath: resolvedPadPath,
    bundledPunctuationFolders: fromAssets,
    downloadedPunctuationIds: downloadedIds,
  };
}

export async function loadStreamingPunctuationModelCatalog(): Promise<PunctuationCatalogSnapshot> {
  const [assetModels, downloadedList] = await Promise.all([
    listAssetModels(),
    listDownloadedModels(ModelCategory.Punctuation),
  ]);

  const fromAssets = assetModels
    .map((m) => m.folder)
    .filter(isStreamingPunctuationNameCandidate);
  const downloadedIds = downloadedList.map((m) => m.id);
  const metaById = new Map(downloadedList.map((m) => [m.id, m] as const));

  let padFolders: string[] = [];
  let resolvedPadPath: string | null = null;
  try {
    const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
    const fallback = `${DocumentDirectoryPath}/models`;
    const base = padPathFromNative ?? fallback;
    const atPath = await listModelsAtPath(base);
    padFolders = (atPath || [])
      .map((m) => m.folder)
      .filter(isStreamingPunctuationNameCandidate);
    if (padFolders.length > 0) {
      resolvedPadPath = base;
    }
  } catch {
    padFolders = [];
  }

  const combined = Array.from(
    new Set([
      ...downloadedIds,
      ...fromAssets,
      ...padFolders.filter(
        (f) => !downloadedIds.includes(f) && !fromAssets.includes(f)
      ),
    ])
  );

  const ctxBase = {
    padModelIds: padFolders,
    padModelsPath: resolvedPadPath,
    bundledFolders: fromAssets,
    downloadedIds: new Set(downloadedIds),
  };

  const ok: PunctuationModelEntry[] = [];
  for (const folder of combined) {
    const mp = getPunctuationModelPathConfig(folder, ctxBase);
    if (await folderIsStreamingCnnBilstm(mp)) {
      ok.push({
        id: folder,
        label: getModelLabel(metaById.get(folder), folder),
      });
    }
  }

  ok.sort((a, b) => a.label.localeCompare(b.label));

  return {
    entries: ok,
    padPunctuationModelIds: padFolders,
    padModelsPath: resolvedPadPath,
    bundledPunctuationFolders: fromAssets,
    downloadedPunctuationIds: downloadedIds,
  };
}
