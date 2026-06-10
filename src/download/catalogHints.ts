import type { CatalogDetectCategory } from './catalogDetectCategories';
export {
  categoryUsesCatalogDetect,
  type CatalogDetectCategory,
} from './catalogDetectCategories';
import {
  detectModelsBatch,
  detectModelResultMatchesCategory,
  type DetectModelMatchedResult,
} from '../detect';
import { ModelCategory, type Quantization, type SizeTier } from './types';

/** Name-only detect output merged into {@link ModelMeta} at registry refresh. */
export type CatalogDetectHint = {
  modelType: string;
  languages: string[];
  quantization: Quantization;
  sizeTier: SizeTier;
  isStreaming: boolean;
  isHardwareSpecificUnsupported?: boolean;
};

function unknownCatalogHint(): CatalogDetectHint {
  return {
    modelType: 'unknown',
    languages: [],
    quantization: 'unknown',
    sizeTier: 'unknown',
    isStreaming: false,
  };
}

function matchedResultToCatalogHint(
  result: DetectModelMatchedResult
): CatalogDetectHint {
  return {
    modelType: result.modelType,
    languages: [...result.languages],
    quantization: result.quantization,
    sizeTier: result.sizeTier,
    isStreaming: result.isStreaming,
    ...(result.isHardwareSpecificUnsupported === true
      ? { isHardwareSpecificUnsupported: true }
      : {}),
  };
}

/**
 * Name-only native detect for every catalog id (no extracted file tree).
 * Uses {@link detectModelsBatch} internally; STT hits with QNN naming set
 * `supportsQnn` when building source models downstream.
 */
export async function buildCatalogHintsMap(
  category: CatalogDetectCategory,
  ids: string[]
): Promise<Map<string, CatalogDetectHint>> {
  const map = new Map<string, CatalogDetectHint>();
  if (ids.length === 0) {
    return map;
  }

  const results = await detectModelsBatch(ids.map((id) => ({ assetName: id })));

  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index]!;
    const result = results[index]!;
    if (result.matched && detectModelResultMatchesCategory(category, result)) {
      map.set(id, matchedResultToCatalogHint(result));
    } else {
      map.set(id, unknownCatalogHint());
    }
  }

  return map;
}

/** @deprecated Use {@link detectModelResultMatchesCategory} on {@link detectModel} results. */
export function catalogDetectHintMatchesCategory(
  category: ModelCategory,
  hint: CatalogDetectHint
): boolean {
  if (hint.modelType === 'unknown') {
    return false;
  }

  const matched: DetectModelMatchedResult = {
    matched: true,
    category: category === ModelCategory.Qnn ? ModelCategory.Stt : category,
    modelType: hint.modelType,
    languages: [...hint.languages],
    quantization: hint.quantization,
    sizeTier: hint.sizeTier,
    isStreaming: hint.isStreaming,
    ...(hint.isHardwareSpecificUnsupported === true
      ? { isHardwareSpecificUnsupported: true }
      : {}),
    ...(category === ModelCategory.Qnn ? { supportsQnn: true } : {}),
  };

  return detectModelResultMatchesCategory(category, matched);
}
