/**
 * OCR model discovery + path resolution (bundled assets, PAD, downloads).
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
} from 'react-native-sherpa-onnx/download';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import type { OcrFamily } from 'react-native-sherpa-onnx/ocr';
import {
  getAssetModelPath,
  getFileModelPath,
  getModelDisplayName,
} from '../modelConfig';
import { RECOMMENDED_MODEL_IDS } from './recommendedModels';

const PAD_PACK_NAME = 'sherpa_models';

const RECOMMENDED_OCR_MODEL_IDS =
  RECOMMENDED_MODEL_IDS[ModelCategory.Ocr] ?? [];

export type OcrModelEntry = {
  id: string;
  label: string;
  recommended?: boolean;
};

export type OcrCatalogSnapshot = {
  entries: OcrModelEntry[];
  padModelIds: string[];
  padModelsPath: string | null;
  bundledFolders: string[];
  downloadedIds: string[];
};

export function isOcrModelFolder(folder: string, hint?: string): boolean {
  if (hint === 'ocr') {
    return true;
  }
  const normalized = folder.toLowerCase();
  return (
    normalized.startsWith('ppocr') ||
    normalized.startsWith('doctr') ||
    normalized.startsWith('docvlm') ||
    normalized.includes('pp-ocr') ||
    normalized.includes('onnxtr') ||
    normalized.includes('granite-docling') ||
    normalized.includes('nemotron-3.5-parse') ||
    normalized.includes('nemotron-parse') ||
    normalized.includes('nemotron_parse') ||
    normalized.includes('paddleocr-vl') ||
    normalized.includes('paddleocr_vl')
  );
}

/** Shared VLM packs that expose maxNewTokens (granite + Nemotron Parse). */
export function isVlmOcrPack(id: string): boolean {
  const lower = id.toLowerCase();
  return (
    lower.includes('docvlm') ||
    lower.includes('granite') ||
    lower.includes('nemotron-3.5-parse') ||
    lower.includes('nemotron-parse') ||
    lower.includes('nemotron_parse') ||
    lower.includes('paddleocr-vl') ||
    lower.includes('paddleocr_vl')
  );
}

export function isPaddleocrVlOcrPack(id: string): boolean {
  const lower = id.toLowerCase();
  return lower.includes('paddleocr-vl') || lower.includes('paddleocr_vl');
}

/** Resolve the public OCR family from a pack folder / catalog id. */
export function inferOcrFamilyFromFolder(folder: string): OcrFamily | null {
  const normalized = folder.toLowerCase();
  if (
    normalized.includes('paddleocr-vl') ||
    normalized.includes('paddleocr_vl')
  ) {
    return 'paddleocr_vl';
  }
  if (
    normalized.includes('nemotron-3.5-parse') ||
    normalized.includes('nemotron-parse') ||
    normalized.includes('nemotron_parse')
  ) {
    return 'nemotron_parse';
  }
  if (
    normalized.startsWith('docvlm') ||
    normalized.includes('granite-docling') ||
    normalized.includes('granite')
  ) {
    return 'doc_vlm';
  }
  if (normalized.startsWith('doctr') || normalized.includes('onnxtr')) {
    return 'doctr';
  }
  if (normalized.startsWith('ppocr') || normalized.includes('pp-ocr')) {
    return 'ppocr';
  }
  return null;
}

export function isDbDetectorOcrFamily(
  family: OcrFamily | null | undefined
): family is 'ppocr' | 'doctr' {
  return family === 'ppocr' || family === 'doctr';
}

export function isVlmOcrFamily(
  family: OcrFamily | null | undefined
): family is 'doc_vlm' | 'nemotron_parse' | 'paddleocr_vl' {
  return (
    family === 'doc_vlm' ||
    family === 'nemotron_parse' ||
    family === 'paddleocr_vl'
  );
}

export function resolveOcrModelSource(
  modelId: string,
  ctx: Pick<
    OcrCatalogSnapshot,
    'padModelIds' | 'padModelsPath' | 'bundledFolders' | 'downloadedIds'
  >
): FileSource {
  if (ctx.padModelIds.includes(modelId)) {
    return ctx.padModelsPath
      ? getFileModelPath(modelId, ModelCategory.Ocr, ctx.padModelsPath)
      : getFileModelPath(modelId, ModelCategory.Ocr);
  }
  if (ctx.downloadedIds.includes(modelId)) {
    return getFileModelPath(modelId, ModelCategory.Ocr);
  }
  if (ctx.bundledFolders.includes(modelId)) {
    return getAssetModelPath(modelId);
  }
  return getAssetModelPath(modelId);
}

export async function loadOcrModelCatalog(): Promise<OcrCatalogSnapshot> {
  const assetModels = await listAssetModels().catch(() => []);
  const bundledFolders = assetModels
    .filter((model) => isOcrModelFolder(model.folder, model.hint))
    .map((model) => model.folder);

  let resolvedPadPath: string | null = null;
  let padIds: string[] = [];
  try {
    const padPathFromNative = await getAssetPackPath(PAD_PACK_NAME);
    const fallbackPath = `${DocumentDirectoryPath}/models`;
    const basePath = padPathFromNative ?? fallbackPath;
    const padModels = await listModelsAtPath(basePath);
    padIds = (padModels || [])
      .filter((model) => isOcrModelFolder(model.folder, model.hint))
      .map((model) => model.folder);
    if (padIds.length > 0) {
      resolvedPadPath = basePath;
    }
  } catch {
    padIds = [];
  }

  const downloaded = await listDownloadedModels(ModelCategory.Ocr).catch(
    () => []
  );
  const downloadedIds = downloaded.map((model) => model.id);

  const combinedIds: string[] = [];
  const pushId = (id: string) => {
    if (!combinedIds.includes(id)) {
      combinedIds.push(id);
    }
  };
  for (const id of padIds) {
    pushId(id);
  }
  for (const id of bundledFolders) {
    pushId(id);
  }
  for (const id of downloadedIds) {
    pushId(id);
  }

  const recommendedSet = new Set(
    RECOMMENDED_OCR_MODEL_IDS.map((id) => id.toLowerCase())
  );
  const entries = combinedIds
    .map((id) => ({
      id,
      label: getModelDisplayName(id),
      recommended:
        recommendedSet.has(id.toLowerCase()) ||
        id.toLowerCase().includes('ppocrv6-tiny'),
    }))
    .sort((a, b) => {
      if (a.recommended !== b.recommended) {
        return a.recommended ? -1 : 1;
      }
      return a.label.localeCompare(b.label);
    });

  return {
    entries,
    padModelIds: padIds,
    padModelsPath: resolvedPadPath,
    bundledFolders,
    downloadedIds,
  };
}
