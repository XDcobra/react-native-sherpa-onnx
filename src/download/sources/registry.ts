import { ModelCategory } from '../types';
import { DownloadError, DOWNLOAD_ERROR_CODES } from './errors';
import type {
  RequestPolicy,
  SourceFetchContext,
  SourceProvider,
} from './types';
import { BUILTIN_GITHUB_PROVIDERS, BUILTIN_SOURCE_IDS } from './builtin';

export interface SourceConfig {
  headers?: Record<string, string>;
  token?: string;
  tokenScheme?: 'Bearer' | string;
  baseUrl?: string;
  requestPolicy?: RequestPolicy;
}

const sourceProviders = new Map<string, SourceProvider>();
const sourceConfigs = new Map<string, SourceConfig>();
const defaultSourceByCategory = new Map<ModelCategory, string>();
const builtinSourceIds = new Set<string>();

let builtinsRegistered = false;

function assertValidSourceId(sourceId: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(sourceId)) {
    throw new Error(
      `Invalid source id "${sourceId}". Use only letters, digits, _, ., and -.`
    );
  }
}

function registerBuiltinSource(provider: SourceProvider): void {
  sourceProviders.set(provider.id, provider);
  builtinSourceIds.add(provider.id);
}

function installBuiltinDefaults(): void {
  for (const category of Object.values(ModelCategory)) {
    defaultSourceByCategory.set(category, BUILTIN_SOURCE_IDS.GITHUB_K2_FSA);
  }

  defaultSourceByCategory.set(
    ModelCategory.Alignment,
    BUILTIN_SOURCE_IDS.GITHUB_XDCOBRA
  );
}

export function ensureBuiltinSourcesRegistered(): void {
  if (builtinsRegistered) {
    return;
  }

  for (const provider of BUILTIN_GITHUB_PROVIDERS) {
    registerBuiltinSource(provider);
  }
  installBuiltinDefaults();
  builtinsRegistered = true;
}

export function registerSource(provider: SourceProvider): void {
  ensureBuiltinSourcesRegistered();
  assertValidSourceId(provider.id);
  sourceProviders.set(provider.id, provider);
}

export function unregisterSource(sourceId: string): void {
  ensureBuiltinSourcesRegistered();

  if (builtinSourceIds.has(sourceId)) {
    return;
  }

  sourceProviders.delete(sourceId);
  sourceConfigs.delete(sourceId);

  for (const [category, value] of defaultSourceByCategory.entries()) {
    if (value === sourceId) {
      defaultSourceByCategory.set(category, BUILTIN_SOURCE_IDS.GITHUB_K2_FSA);
    }
  }
}

export function getSource(sourceId: string): SourceProvider {
  ensureBuiltinSourcesRegistered();
  const provider = sourceProviders.get(sourceId);
  if (!provider) {
    throw new DownloadError(
      DOWNLOAD_ERROR_CODES.UNKNOWN_SOURCE,
      `Unknown source: ${sourceId}`,
      {
        source: sourceId,
      }
    );
  }
  return provider;
}

export function tryGetSource(sourceId: string): SourceProvider | undefined {
  ensureBuiltinSourcesRegistered();
  return sourceProviders.get(sourceId);
}

export function listSources(): SourceProvider[] {
  ensureBuiltinSourcesRegistered();
  return [...sourceProviders.values()];
}

export function listBuiltinSources(): SourceProvider[] {
  ensureBuiltinSourcesRegistered();
  return [...builtinSourceIds]
    .map((sourceId) => sourceProviders.get(sourceId))
    .filter((provider): provider is SourceProvider => provider != null);
}

export function configureSource(sourceId: string, config: SourceConfig): void {
  ensureBuiltinSourcesRegistered();
  getSource(sourceId);

  const previous = sourceConfigs.get(sourceId) ?? {};
  sourceConfigs.set(sourceId, {
    ...previous,
    ...config,
    headers: {
      ...(previous.headers ?? {}),
      ...(config.headers ?? {}),
    },
    requestPolicy: {
      ...(previous.requestPolicy ?? {}),
      ...(config.requestPolicy ?? {}),
    },
  });
}

export function getSourceConfig(sourceId: string): Readonly<SourceConfig> {
  ensureBuiltinSourcesRegistered();
  return sourceConfigs.get(sourceId) ?? {};
}

export function setDefaultSourceForCategory(
  category: ModelCategory,
  sourceId: string
): void {
  ensureBuiltinSourcesRegistered();

  const provider = getSource(sourceId);
  if (!provider.supportsCategory(category)) {
    throw new DownloadError(
      DOWNLOAD_ERROR_CODES.SOURCE_LIST_FAILED,
      `Source ${sourceId} does not support category ${category}`,
      {
        source: sourceId,
        category,
      }
    );
  }

  defaultSourceByCategory.set(category, sourceId);
}

export function getDefaultSourceForCategory(category: ModelCategory): string {
  ensureBuiltinSourcesRegistered();
  return (
    defaultSourceByCategory.get(category) ?? BUILTIN_SOURCE_IDS.GITHUB_K2_FSA
  );
}

export function buildSourceFetchContext(
  sourceId: string,
  provider: SourceProvider,
  options?: {
    signal?: AbortSignal;
    requestPolicy?: RequestPolicy;
    headers?: Record<string, string>;
  }
): SourceFetchContext {
  const config = getSourceConfig(sourceId);
  const headers: Record<string, string> = {
    ...(provider.defaultHeaders?.() ?? {}),
    ...(config.headers ?? {}),
    ...(options?.headers ?? {}),
  };

  return {
    sourceId,
    headers,
    token: config.token,
    tokenScheme: config.tokenScheme,
    baseUrl: config.baseUrl,
    requestPolicy: {
      retries:
        options?.requestPolicy?.retries ?? config.requestPolicy?.retries ?? 0,
      initialDelayMs:
        options?.requestPolicy?.initialDelayMs ??
        config.requestPolicy?.initialDelayMs,
      maxDelayMs:
        options?.requestPolicy?.maxDelayMs ?? config.requestPolicy?.maxDelayMs,
      timeoutMs:
        options?.requestPolicy?.timeoutMs ?? config.requestPolicy?.timeoutMs,
    },
    signal: options?.signal,
  };
}
