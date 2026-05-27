import { categoryUsesCatalogDetect } from '../catalogDetectCategories';
import { buildCatalogHintsMap, type CatalogDetectHint } from '../catalogHints';
import { ModelCategory, type Quantization, type SizeTier } from '../types';
import type { SourceModel } from './types';
import {
  getAssetExtension,
  isAssetSupportedForCategory,
  stripAssetExtension,
} from './github-asset-rules';

export {
  getAssetExtension,
  isAssetSupportedForCategory,
  stripAssetExtension,
} from './github-asset-rules';

export type GitHubReleaseAsset = {
  name: string;
  size: number;
  browser_download_url: string;
  digest?: string;
};

function toTitleCase(value: string): string {
  return value
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((token) => {
      const first = token[0] ?? '';
      return first.toUpperCase() + token.slice(1);
    })
    .join(' ');
}

export function deriveDisplayName(id: string): string {
  const cleaned = id.replace(/^sherpa-onnx-/, '');
  return toTitleCase(cleaned);
}

function parseDigestSha256(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const match = value.match(/^sha256:([a-f0-9]{64})$/i);
  return match?.[1]?.toLowerCase();
}

function collectModelIdsFromAssets(
  category: ModelCategory,
  assets: GitHubReleaseAsset[]
): string[] {
  const out: string[] = [];
  for (const asset of assets) {
    const ext = getAssetExtension(asset.name);
    if (!ext) {
      continue;
    }
    if (!isAssetSupportedForCategory(category, asset.name, ext)) {
      continue;
    }
    out.push(stripAssetExtension(asset.name, ext));
  }
  return out;
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

function toSourceModel(
  category: ModelCategory,
  asset: GitHubReleaseAsset,
  ext: 'tar.bz2' | 'onnx'
): SourceModel {
  const id = stripAssetExtension(asset.name, ext);
  const sha256 = parseDigestSha256(asset.digest);

  if (ext === 'tar.bz2') {
    return {
      id,
      displayName: deriveDisplayName(id),
      category,
      layout: {
        kind: 'archive',
        format: 'tar.bz2',
        extract: true,
      },
      assets: [
        {
          relativePath: asset.name,
          url: asset.browser_download_url,
          bytes: asset.size,
          sha256,
        },
      ],
      bytes: asset.size,
    };
  }

  return {
    id,
    displayName: deriveDisplayName(id),
    category,
    layout: {
      kind: 'folder',
      format: 'none',
      extract: false,
    },
    assets: [
      {
        relativePath: asset.name,
        url: asset.browser_download_url,
        bytes: asset.size,
        sha256,
      },
    ],
    bytes: asset.size,
  };
}

export async function buildSourceModelsFromGithubReleaseAssets(
  category: ModelCategory,
  assets: GitHubReleaseAsset[]
): Promise<SourceModel[]> {
  let hints = new Map<string, CatalogDetectHint>();
  if (categoryUsesCatalogDetect(category)) {
    const ids = collectModelIdsFromAssets(category, assets);
    hints = await buildCatalogHintsMap(category, ids);
  }

  const models: SourceModel[] = [];
  for (const asset of assets) {
    const ext = getAssetExtension(asset.name);
    if (!ext) {
      continue;
    }

    if (!isAssetSupportedForCategory(category, asset.name, ext)) {
      continue;
    }

    const base = toSourceModel(category, asset, ext);
    const hint = hints.get(base.id);
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

export function parseChecksumTxt(content: string): Map<string, string> {
  const checksums = new Map<string, string>();
  const lines = content.split('\n').filter((line) => line.trim());

  for (const line of lines) {
    const [filename, hash] = line.split(/\s+/);
    if (filename && hash) {
      checksums.set(filename.trim(), hash.trim().toLowerCase());
    }
  }

  return checksums;
}
