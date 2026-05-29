import { ModelCategory } from '../../types';
import { DownloadError, DOWNLOAD_ERROR_CODES } from '../errors';
import { sourceFetch } from '../fetch';
import type { SourceModel, SourceProvider } from '../types';
import { getDefaultHuggingFaceRepos } from './huggingface-defaults';

export interface HuggingFaceRepoSpec {
  repo: string;
  revision?: string;
  id?: string;
  includeFiles?: ReadonlyArray<string | RegExp>;
  excludeFiles?: ReadonlyArray<string | RegExp>;
  modelType?: string;
  languages?: string[];
  quantization?: 'fp16' | 'int8' | 'int8-quantized' | 'unknown';
  sizeTier?: 'tiny' | 'small' | 'medium' | 'large' | 'unknown';
  isStreaming?: boolean;
}

export interface HuggingFaceSourceConfig {
  repos?: Partial<Record<ModelCategory, HuggingFaceRepoSpec[]>>;
  mergeWithDefaults?: boolean;
}

let userConfig: HuggingFaceSourceConfig | null = null;

export function configureHuggingFaceSource(
  config: HuggingFaceSourceConfig
): void {
  userConfig = userConfig
    ? {
        ...userConfig,
        ...config,
        repos: {
          ...(userConfig.repos ?? {}),
          ...(config.repos ?? {}),
        },
      }
    : { ...config };
}

export function getHuggingFaceSourceConfig(): Readonly<HuggingFaceSourceConfig> {
  return userConfig ?? {};
}

function matchRule(path: string, rule: string | RegExp): boolean {
  if (rule instanceof RegExp) {
    return rule.test(path);
  }

  const normalized = rule.toLowerCase();
  if (normalized.startsWith('*.')) {
    const ext = normalized.slice(1);
    return path.toLowerCase().endsWith(ext);
  }

  return path.toLowerCase().includes(normalized);
}

function matchesIncludeExclude(
  path: string,
  includes?: ReadonlyArray<string | RegExp>,
  excludes?: ReadonlyArray<string | RegExp>
): boolean {
  const includeMatch =
    !includes || includes.length === 0
      ? true
      : includes.some((rule) => matchRule(path, rule));

  if (!includeMatch) {
    return false;
  }

  const excludeMatch = excludes?.some((rule) => matchRule(path, rule)) ?? false;
  return !excludeMatch;
}

function repoFileUrl(repo: string, revision: string, path: string): string {
  return `https://huggingface.co/${repo}/resolve/${revision}/${encodeURI(
    path
  )}`;
}

function modelIdFromSpec(spec: HuggingFaceRepoSpec): string {
  const revision = spec.revision ?? 'main';
  const ownerless = spec.repo.split('/').pop() ?? spec.repo;
  return `${ownerless}@${revision}`;
}

function resolveRepos(category: ModelCategory): HuggingFaceRepoSpec[] {
  const config = userConfig;
  const defaults = getDefaultHuggingFaceRepos(category);
  const userRepos = config?.repos?.[category] ?? [];

  if (userRepos.length === 0) {
    return defaults;
  }

  return config?.mergeWithDefaults ? [...defaults, ...userRepos] : userRepos;
}

type HuggingFaceSibling = {
  rfilename: string;
  size?: number;
  lfs?: {
    sha256?: string;
    size?: number;
  };
};

export const huggingfaceProvider: SourceProvider = {
  id: 'huggingface',
  label: 'Hugging Face Hub',
  supportsCategory() {
    return true;
  },
  async listModels(category, ctx) {
    const specs = resolveRepos(category);
    const models: SourceModel[] = [];

    for (const spec of specs) {
      const revision = spec.revision ?? 'main';
      const url =
        `https://huggingface.co/api/models/${spec.repo}` +
        `?revision=${encodeURIComponent(revision)}`;

      let body: { siblings?: HuggingFaceSibling[] };
      try {
        const { response } = await sourceFetch(url, ctx);
        body = (await response.json()) as { siblings?: HuggingFaceSibling[] };
      } catch (error) {
        if (error instanceof DownloadError) {
          throw error;
        }
        throw new DownloadError(
          DOWNLOAD_ERROR_CODES.SOURCE_LIST_FAILED,
          `Hugging Face list failed for ${spec.repo}@${revision}`,
          {
            source: ctx.sourceId,
            category,
            cause: error,
          }
        );
      }

      const siblings = Array.isArray(body.siblings) ? body.siblings : [];
      const selected = siblings.filter((entry) =>
        matchesIncludeExclude(
          entry.rfilename,
          spec.includeFiles,
          spec.excludeFiles
        )
      );

      if (selected.length === 0) {
        continue;
      }

      const assets = selected.map((entry) => ({
        relativePath: entry.rfilename,
        url: repoFileUrl(spec.repo, revision, entry.rfilename),
        bytes: entry.lfs?.size ?? entry.size,
        sha256: entry.lfs?.sha256?.toLowerCase(),
      }));

      const bytes = assets.reduce((sum, asset) => sum + (asset.bytes ?? 0), 0);
      const modelId = modelIdFromSpec(spec);

      models.push({
        id: modelId,
        displayName: spec.id ?? modelId,
        category,
        layout: {
          kind: 'folder',
          format: 'none',
          extract: false,
        },
        assets,
        bytes,
        modelType: spec.modelType,
        languages: spec.languages,
        quantization: spec.quantization,
        sizeTier: spec.sizeTier,
        isStreaming: spec.isStreaming,
      });
    }

    return models;
  },
  defaultHeaders() {
    return {
      Accept: 'application/json',
    };
  },
};
