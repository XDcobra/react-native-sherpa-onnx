/**
 * Resolve per-file LFS SHA-256 digests from the Hugging Face Hub model API.
 * Uses `?blobs=true` so `siblings[].lfs.sha256` is populated.
 */

import { sourceFetch } from './sources/fetch';
import {
  buildSourceFetchContext,
  ensureBuiltinSourcesRegistered,
  getSource,
} from './sources/registry';

export type HfFileDigest = {
  relativePath: string;
  sha256?: string;
  bytes?: number;
};

type HfSibling = {
  rfilename?: string;
  size?: number;
  lfs?: {
    sha256?: string;
    oid?: string;
    size?: number;
  };
};

/** Prefer `lfs.sha256`, fall back to `lfs.oid` (same hex from Hub). */
export function digestFromHfLfs(lfs: HfSibling['lfs']): string | undefined {
  if (!lfs) return undefined;
  if (typeof lfs.sha256 === 'string' && lfs.sha256.length > 0) {
    return lfs.sha256.toLowerCase();
  }
  if (typeof lfs.oid === 'string' && lfs.oid.length > 0) {
    return lfs.oid.toLowerCase();
  }
  return undefined;
}

/** Pure mapper for Hub `siblings` (used by resolve + unit tests). */
export function mapHfSiblingsToDigests(
  siblings: HfSibling[] | undefined
): Map<string, HfFileDigest> {
  const out = new Map<string, HfFileDigest>();
  if (!Array.isArray(siblings)) return out;

  for (const sibling of siblings) {
    const relativePath = sibling.rfilename?.trim();
    if (!relativePath) continue;
    out.set(relativePath, {
      relativePath,
      sha256: digestFromHfLfs(sibling.lfs),
      bytes:
        typeof sibling.lfs?.size === 'number'
          ? sibling.lfs.size
          : typeof sibling.size === 'number'
          ? sibling.size
          : undefined,
    });
  }

  return out;
}

/**
 * Fetch Hub metadata for a repo and return digests keyed by `rfilename`.
 */
export async function resolveHuggingFaceRepoDigests(
  repo: string,
  options?: {
    revision?: string;
    signal?: AbortSignal;
    sourceId?: string;
  }
): Promise<Map<string, HfFileDigest>> {
  const revision = options?.revision ?? 'main';
  const url =
    `https://huggingface.co/api/models/${repo}` +
    `?revision=${encodeURIComponent(revision)}&blobs=true`;

  ensureBuiltinSourcesRegistered();
  const sourceId = options?.sourceId ?? 'huggingface';
  const ctx = buildSourceFetchContext(sourceId, getSource(sourceId), {
    signal: options?.signal,
  });

  const { response } = await sourceFetch(url, ctx);
  const body = (await response.json()) as { siblings?: HfSibling[] };
  return mapHfSiblingsToDigests(body.siblings);
}
