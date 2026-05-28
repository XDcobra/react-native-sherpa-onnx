import {
  detectModelsBatch,
  detectModelResultMatchesCategory,
  type DetectModelMatchedResult,
  type DetectModelResult,
} from '../../detect';
import { categoryUsesCatalogDetect } from '../catalogDetectCategories';
import type { CatalogDetectHint } from '../catalogHints';
import { ModelCategory, type Quantization, type SizeTier } from '../types';
import type { SourceAssetEntry, SourceModel } from './types';
import { deriveDisplayName } from './github-common';

function matchedResultToCatalogHint(
  result: DetectModelMatchedResult
): CatalogDetectHint {
  return {
    modelType: result.modelType,
    languages: [...result.languages],
    quantization: result.quantization as Quantization,
    sizeTier: result.sizeTier as SizeTier,
    isStreaming: result.isStreaming,
    ...(result.isHardwareSpecificUnsupported === true
      ? { isHardwareSpecificUnsupported: true }
      : {}),
  };
}

function applyCatalogHint(
  model: SourceModel,
  hint: CatalogDetectHint,
  options?: { supportsQnn?: boolean }
): SourceModel {
  return {
    ...model,
    modelType: hint.modelType,
    languages: [...hint.languages],
    quantization: hint.quantization as Quantization,
    sizeTier: hint.sizeTier as SizeTier,
    isStreaming: hint.isStreaming,
    ...(options?.supportsQnn === true ? { supportsQnn: true } : {}),
    ...(hint.isHardwareSpecificUnsupported === true
      ? { isHardwareSpecificUnsupported: true }
      : {}),
  };
}

export type BuildHfAuthorSourceModelsOptions = {
  hfOrg: string;
  revision: string;
  /**
   * Resolve download assets for one repo. GitHub releases embed URLs in the
   * release payload; HF folder repos need a siblings lookup — callers may
   * return cached assets, fetch remotely, or a minimal placeholder until download.
   */
  resolveAssets: (
    fullRepo: string,
    repoName: string
  ) => Promise<SourceAssetEntry[]>;
  /**
   * When set, skips an internal {@link detectModelsBatch} call. Length must match
   * `repoNames` order (one result per repo).
   */
  detectResults?: readonly DetectModelResult[];
};

/**
 * Build HF author source models using unified {@link detectModelsBatch} category
 * resolution (single native detect pass per repo).
 */
export async function buildSourceModelsFromHfAuthorRepoNames(
  category: ModelCategory,
  repoNames: Iterable<string>,
  options: BuildHfAuthorSourceModelsOptions
): Promise<SourceModel[]> {
  const repoNameList = [...repoNames];
  const detectResults =
    options.detectResults ??
    (categoryUsesCatalogDetect(category) && repoNameList.length > 0
      ? await detectModelsBatch(
          repoNameList.map((repoName) => ({ assetName: repoName }))
        )
      : []);

  const models: SourceModel[] = [];

  for (let index = 0; index < repoNameList.length; index += 1) {
    const repoName = repoNameList[index]!;
    const detect = detectResults[index];

    if (
      categoryUsesCatalogDetect(category) &&
      (!detect?.matched ||
        !detectModelResultMatchesCategory(category, detect) ||
        detect.isHardwareSpecificUnsupported === true)
    ) {
      continue;
    }

    const fullRepo = `${options.hfOrg}/${repoName}`;
    const assets = await options.resolveAssets(fullRepo, repoName);
    if (assets.length === 0) {
      continue;
    }

    const bytes = assets.reduce((sum, asset) => sum + (asset.bytes ?? 0), 0);
    const base: SourceModel = {
      id: repoName,
      displayName: deriveDisplayName(repoName),
      category,
      layout: {
        kind: 'folder',
        format: 'none',
        extract: false,
      },
      assets,
      bytes,
    };

    const enriched =
      detect?.matched === true
        ? applyCatalogHint(base, matchedResultToCatalogHint(detect), {
            supportsQnn: detect.supportsQnn === true,
          })
        : base;

    if (enriched.isHardwareSpecificUnsupported === true) {
      continue;
    }

    models.push(enriched);
  }

  return models;
}

export function hfRepoResolveUrl(
  fullRepo: string,
  revision: string,
  relativePath: string
): string {
  const encoded = relativePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `https://huggingface.co/${fullRepo}/resolve/${revision}/${encoded}`;
}

/** Paths included when building HF folder download asset lists. */
export function isIncludedHfModelPath(relativePath: string): boolean {
  const normalized = relativePath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (!normalized || normalized.endsWith('/')) {
    return false;
  }
  // Keep full repo file trees for HF folder models (e.g. espeak-ng-data/**),
  // but avoid VCS metadata paths.
  if (normalized.startsWith('.git/')) {
    return false;
  }
  return true;
}

export type HfSiblingLike = {
  rfilename?: string;
  size?: number;
  lfs?: {
    size?: number;
    sha256?: string;
  };
};

export function buildFolderAssetsFromHfSiblings(
  fullRepo: string,
  revision: string,
  siblings: HfSiblingLike[]
): SourceAssetEntry[] {
  const assets: SourceAssetEntry[] = [];

  for (const sibling of siblings) {
    const relativePath = sibling.rfilename?.trim();
    if (!relativePath || !isIncludedHfModelPath(relativePath)) {
      continue;
    }

    assets.push({
      relativePath,
      url: hfRepoResolveUrl(fullRepo, revision, relativePath),
      bytes:
        typeof sibling.lfs?.size === 'number'
          ? sibling.lfs.size
          : typeof sibling.size === 'number'
          ? sibling.size
          : undefined,
      sha256:
        typeof sibling.lfs?.sha256 === 'string'
          ? sibling.lfs.sha256.toLowerCase()
          : undefined,
    });
  }

  return assets;
}

export {
  filterHfRepoNamesForCategory,
  isHfRepoNameSupportedForCategory,
} from './hf-author-filter';

/** @deprecated Use {@link detectModelResultMatchesCategory} from the SDK root detect API. */
export { catalogDetectHintMatchesCategory } from '../catalogHints';
