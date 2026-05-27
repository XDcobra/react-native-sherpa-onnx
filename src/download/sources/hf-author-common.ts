import { buildCatalogHintsMap, type CatalogDetectHint } from '../catalogHints';
import { categoryUsesCatalogDetect } from '../catalogDetectCategories';
import { ModelCategory, type Quantization, type SizeTier } from '../types';
import type { SourceAssetEntry, SourceModel } from './types';
import { deriveDisplayName } from './github-common';
import { filterHfRepoNamesForCategory } from './hf-author-filter';

export {
  filterHfRepoNamesForCategory,
  isHfRepoNameSupportedForCategory,
} from './hf-author-filter';

const TTS_DETECT_MODEL_TYPES = new Set([
  'vits',
  'matcha',
  'kokoro',
  'kitten',
  'pocket',
  'zipvoice',
  'supertonic',
]);

const STT_DETECT_MODEL_TYPES = new Set([
  'transducer',
  'nemo_transducer',
  'paraformer',
  'nemo_ctc',
  'wenet_ctc',
  'sense_voice',
  'zipformer_ctc',
  'ctc',
  'whisper',
  'funasr_nano',
  'qwen3_asr',
  'cohere_transcribe',
  'fire_red_asr',
  'moonshine',
  'dolphin',
  'canary',
  'omnilingual',
  'medasr',
  'telespeech_ctc',
]);

/**
 * GitHub releases are per-category; the HF author index is flat. After the shared
 * filename filter, use the category-specific `detect*Model` `modelType` to keep
 * only rows that belong in the requested catalog slice.
 */
export function catalogDetectHintMatchesCategory(
  category: ModelCategory,
  hint: CatalogDetectHint
): boolean {
  if (hint.modelType === 'unknown') {
    return true;
  }

  const mt = hint.modelType.toLowerCase();

  switch (category) {
    case ModelCategory.Tts:
      return TTS_DETECT_MODEL_TYPES.has(mt);
    case ModelCategory.Stt:
    case ModelCategory.Qnn:
      return STT_DETECT_MODEL_TYPES.has(mt);
    case ModelCategory.Vad:
      return mt.includes('vad') || mt.includes('silero');
    case ModelCategory.Punctuation:
      return mt.includes('punct') || mt.includes('ct-transformer');
    case ModelCategory.Enhancement:
      return (
        mt.includes('gtcrn') ||
        mt.includes('nsnet') ||
        mt.includes('enhancement')
      );
    case ModelCategory.Alignment:
      return mt.includes('align');
    case ModelCategory.Diarization:
    case ModelCategory.Separation:
      return true;
    default:
      return true;
  }
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
};

/**
 * Same pipeline as {@link buildSourceModelsFromGithubReleaseAssets}: filter ids by
 * name rules, enrich with native `detect*Model` catalog hints, build `SourceModel`.
 */
export async function buildSourceModelsFromHfAuthorRepoNames(
  category: ModelCategory,
  repoNames: Iterable<string>,
  options: BuildHfAuthorSourceModelsOptions
): Promise<SourceModel[]> {
  const supported = filterHfRepoNamesForCategory(category, repoNames);

  let hints = new Map<string, CatalogDetectHint>();
  if (categoryUsesCatalogDetect(category)) {
    hints = await buildCatalogHintsMap(category, supported);
  }

  const models: SourceModel[] = [];

  for (const repoName of supported) {
    const hint = hints.get(repoName);
    if (hint?.isHardwareSpecificUnsupported === true) {
      continue;
    }
    if (
      hint &&
      categoryUsesCatalogDetect(category) &&
      !catalogDetectHintMatchesCategory(category, hint)
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

    const enriched = hint
      ? applyCatalogHint(base, hint, {
          supportsQnn: category === ModelCategory.Qnn,
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
  const lower = relativePath.toLowerCase();
  const basename = lower.split('/').pop() ?? lower;

  if (lower.endsWith('.onnx')) return true;
  if (basename === 'tokens.txt') return true;
  if (basename.startsWith('vocab') && basename.endsWith('.txt')) return true;
  if (basename.startsWith('lexicon') && basename.endsWith('.txt')) return true;
  if (lower.endsWith('.bin')) return true;
  if (basename.startsWith('config') && basename.endsWith('.json')) return true;
  if (basename.startsWith('readme')) return true;
  if (basename.startsWith('license')) return true;

  return false;
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
