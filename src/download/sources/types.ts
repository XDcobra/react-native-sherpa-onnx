import type { ModelCategory, Quantization, SizeTier } from '../types';

export type SourceArchiveFormat = 'tar.bz2' | 'tar.gz' | 'tar.xz' | 'tar.zst';

export type SourceAssetLayout =
  | {
      kind: 'archive';
      format: SourceArchiveFormat;
      extract: boolean;
    }
  | {
      kind: 'folder';
      format: 'none';
      extract: false;
    };

export interface SourceAssetEntry {
  relativePath: string;
  url: string;
  bytes?: number;
  sha256?: string;
}

export interface SourceModel {
  id: string;
  displayName: string;
  category: ModelCategory;
  layout: SourceAssetLayout;
  assets: SourceAssetEntry[];
  bytes: number;
  modelType?: string;
  languages?: string[];
  quantization?: Quantization;
  sizeTier?: SizeTier;
  isStreaming?: boolean;
  supportsQnn?: boolean;
  isHardwareSpecificUnsupported?: boolean;
}

export interface RequestPolicy {
  retries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
}

export interface SourceFetchContext {
  sourceId: string;
  headers: Readonly<Record<string, string>>;
  baseUrl?: string;
  token?: string;
  tokenScheme?: 'Bearer' | string;
  requestPolicy: Readonly<RequestPolicy>;
  signal?: AbortSignal;
}

export interface SourceProvider {
  readonly id: string;
  readonly label: string;
  supportsCategory(category: ModelCategory): boolean;
  listModels(
    category: ModelCategory,
    ctx: SourceFetchContext
  ): Promise<SourceModel[]>;
  getChecksums?(
    category: ModelCategory,
    ctx: SourceFetchContext
  ): Promise<Map<string, string> | undefined>;
  defaultHeaders?(): Readonly<Record<string, string>>;
}

export function isArchiveLayout(
  layout: SourceAssetLayout
): layout is Extract<SourceAssetLayout, { kind: 'archive' }> {
  return layout.kind === 'archive';
}

export function isFolderLayout(
  layout: SourceAssetLayout
): layout is Extract<SourceAssetLayout, { kind: 'folder' }> {
  return layout.kind === 'folder';
}
