/**
 * Shared utilities for resolving a {@link FileSource} into the inputs
 * required by the native `detectXxxModel` methods.
 */
import SherpaOnnx from './NativeSherpaOnnx';
import type { FileSource } from './fileio/types';
import { resolveActualModelDir } from './download/validation';

/** Resolved fields that every native detect method needs. */
export interface ResolvedDetectInput {
  /**
   * Absolute filesystem directory path for file-tree detection,
   * or `''` when no listable directory is available (name-only mode).
   */
  modelDir: string;
  /**
   * Release-asset stem / folder basename for name-based heuristics.
   * `null` when no usable name can be derived.
   */
  assetName: string | null;
}

/**
 * Derive a bare asset/folder name from a path string by stripping to the
 * last segment and removing common archive suffixes.
 */
function deriveAssetName(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const leaf = trimmed.split(/[\\/]/).filter(Boolean).pop();
  if (!leaf) return null;
  return leaf
    .replace(/\.tar\.bz2$/i, '')
    .replace(/\.tar\.gz$/i, '')
    .replace(/\.tgz$/i, '')
    .replace(/\.zip$/i, '');
}

/** Extract a human-readable file/path segment from a URI for name-only heuristics. */
function deriveAssetNameFromUri(uri: string): string | null {
  try {
    // Strip query/fragment, decode, grab last path segment
    const pathPart = uri.split('?')[0]!.split('#')[0]!;
    const decoded = decodeURIComponent(pathPart);
    return deriveAssetName(decoded);
  } catch {
    return null;
  }
}

/**
 * Resolve a {@link FileSource} into the `modelDir` + `assetName` required by
 * native detect methods.
 *
 * - **fs**: path used directly (with install-dir resolution).
 * - **app**: base dir resolved via native helper + path appended.
 * - **pad**: asset pack path resolved via native helper + path appended.
 * - **contentUri** / **securityScoped**: directory is empty (name-only mode),
 *   asset name is derived from the URI.
 */
export async function resolveFileSourceForDetect(
  source: FileSource
): Promise<ResolvedDetectInput> {
  switch (source.kind) {
    case 'fs': {
      const modelDir = await resolveActualModelDir(source.path);
      return { modelDir, assetName: deriveAssetName(source.path) };
    }

    case 'app': {
      const baseDir = await SherpaOnnx.resolveAppBaseDir(source.base);
      const fullPath = `${baseDir}/${source.path}`.replace(/\/+/g, '/');
      const modelDir = await resolveActualModelDir(fullPath);
      return { modelDir, assetName: deriveAssetName(source.path) };
    }

    case 'pad': {
      const packPath = await SherpaOnnx.getAssetPackPath(source.packName);
      if (!packPath) {
        // Pack not available — fall back to name-only detection
        return { modelDir: '', assetName: deriveAssetName(source.path) };
      }
      const fullPath = `${packPath}/${source.path}`.replace(/\/+/g, '/');
      const modelDir = await resolveActualModelDir(fullPath);
      return { modelDir, assetName: deriveAssetName(source.path) };
    }

    case 'contentUri':
      return { modelDir: '', assetName: deriveAssetNameFromUri(source.uri) };

    case 'securityScoped':
      return { modelDir: '', assetName: deriveAssetNameFromUri(source.uri) };
  }
}
