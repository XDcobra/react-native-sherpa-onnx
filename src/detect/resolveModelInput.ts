/**
 * Map {@link FileSource} (from `fileio`) to native detect/init inputs (`modelDir` + `assetName`).
 *
 * This is not part of `fileio`: `fileio` handles copy/save/share and defines source *types*.
 * Model engines need a filesystem directory and/or a release-asset name for heuristics —
 * that mapping lives here and is shared by `detectModel`, `detectSttModel`, `createTTS`, etc.
 *
 * Concrete kinds/bases map to exactly one strategy. `kind: 'auto'` tries an explicit
 * {@link FileSourceAutoTryTarget} list in order and uses the first resolvable directory.
 */
import { exists } from '@dr.pogodin/react-native-fs';
import { Platform } from 'react-native';
import SherpaOnnx from '../NativeSherpaOnnx';
import {
  FileIOErrorCode,
  type FileSource,
  type FileSourceAutoTryTarget,
} from '../fileio/types';
import { resolveActualModelDir } from '../download/validation';

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

type ConcreteFileSource = Exclude<FileSource, { kind: 'auto' }>;

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

function deriveAssetNameFromUri(uri: string): string | null {
  try {
    const pathPart = uri.split('?')[0]!.split('#')[0]!;
    const decoded = decodeURIComponent(pathPart);
    return deriveAssetName(decoded);
  } catch {
    return null;
  }
}

function createFileIOError(code: string, message: string): never {
  const err = new Error(message) as Error & { code?: string };
  err.code = code;
  throw err;
}

function platformOs(): string {
  return (Platform as { OS?: string } | undefined)?.OS ?? 'unknown';
}

function normalizeRelativePathForDetect(
  path: string,
  locationKind: 'app' | 'pad'
): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return '';
  }

  const normalized = trimmed.replace(/\\/g, '/');

  if (normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) {
    createFileIOError(
      FileIOErrorCode.PATH_TRAVERSAL_BLOCKED,
      `${locationKind} source path must be relative: ${path}`
    );
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..')) {
    createFileIOError(
      FileIOErrorCode.PATH_TRAVERSAL_BLOCKED,
      `Path traversal is not allowed in ${locationKind} source path: ${path}`
    );
  }

  return segments
    .filter((segment) => segment.length > 0 && segment !== '.')
    .join('/');
}

function joinBaseAndRelativePath(
  baseDir: string,
  relativePath: string
): string {
  if (relativePath.length === 0) {
    return baseDir;
  }
  return `${baseDir.replace(/[/\\]+$/, '')}/${relativePath}`;
}

async function resolveBundledRelativePath(
  safeRelativePath: string
): Promise<string> {
  const resolvedAssetPath = await SherpaOnnx.resolveBundledAssetPath(
    safeRelativePath
  );
  if (!resolvedAssetPath?.trim()) {
    createFileIOError(
      FileIOErrorCode.NOT_FOUND,
      `Bundled asset path not found: ${safeRelativePath}`
    );
  }
  return resolvedAssetPath;
}

function toFileIOResolveError(error: unknown): Error {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('FILEIO_')) {
      return error;
    }

    const wrapped = new Error(error.message) as Error & { code?: string };
    wrapped.code =
      typeof code === 'string' && code.length > 0
        ? code
        : FileIOErrorCode.RESOLVE_ERROR;
    return wrapped;
  }

  const wrapped = new Error(String(error)) as Error & { code?: string };
  wrapped.code = FileIOErrorCode.RESOLVE_ERROR;
  return wrapped;
}

function fileSourceErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isFatalAutoResolveError(error: unknown): boolean {
  const code = fileSourceErrorCode(error);
  return (
    code === FileIOErrorCode.INVALID_ARGUMENT ||
    code === FileIOErrorCode.PATH_TRAVERSAL_BLOCKED
  );
}

function autoTryTargetLabel(target: FileSourceAutoTryTarget): string {
  if (typeof target === 'string') {
    return target;
  }
  return `pad:${target.pad}`;
}

function fileSourceFromAutoTryTarget(
  target: FileSourceAutoTryTarget,
  path: string
): ConcreteFileSource {
  if (target === 'fs') {
    return { kind: 'fs', path };
  }
  if (typeof target === 'object') {
    return { kind: 'pad', packName: target.pad, path };
  }
  return { kind: 'app', base: target, path };
}

function validateAutoFileSource(source: {
  kind: 'auto';
  path: string;
  tryOrder?: FileSourceAutoTryTarget[];
}): void {
  if (!source.tryOrder || source.tryOrder.length === 0) {
    createFileIOError(
      FileIOErrorCode.INVALID_ARGUMENT,
      "FileSource kind 'auto' requires a non-empty tryOrder array"
    );
  }

  for (const target of source.tryOrder!) {
    if (typeof target === 'object' && !target.pad?.trim()) {
      createFileIOError(
        FileIOErrorCode.INVALID_ARGUMENT,
        "FileSource tryOrder pad entry requires a non-empty 'pad' pack name"
      );
    }
  }
}

async function isUsableModelDirectory(modelDir: string): Promise<boolean> {
  const trimmed = modelDir.trim();
  if (!trimmed) {
    return false;
  }
  try {
    return await exists(trimmed);
  } catch {
    return false;
  }
}

async function resolveConcreteFileSourceForDetect(
  source: ConcreteFileSource
): Promise<ResolvedDetectInput> {
  switch (source.kind) {
    case 'fs': {
      const modelDir = await resolveActualModelDir(source.path);
      return { modelDir, assetName: deriveAssetName(source.path) };
    }

    case 'app': {
      const safeRelativePath = normalizeRelativePathForDetect(
        source.path,
        'app'
      );
      if (source.base === 'apkAsset') {
        if (platformOs() !== 'android') {
          createFileIOError(
            FileIOErrorCode.UNSUPPORTED_ON_PLATFORM,
            'app:apkAsset is supported on Android only. Use app:appBundle or fs on this platform.'
          );
        }
        const resolvedAssetPath = await resolveBundledRelativePath(
          safeRelativePath
        );
        const modelDir = await resolveActualModelDir(resolvedAssetPath);
        return { modelDir, assetName: deriveAssetName(source.path) };
      }
      if (source.base === 'appBundle') {
        if (platformOs() !== 'ios') {
          createFileIOError(
            FileIOErrorCode.UNSUPPORTED_ON_PLATFORM,
            'app:appBundle is supported on iOS only. Use app:apkAsset or fs on this platform.'
          );
        }
        const resolvedAssetPath = await resolveBundledRelativePath(
          safeRelativePath
        );
        const modelDir = await resolveActualModelDir(resolvedAssetPath);
        return { modelDir, assetName: deriveAssetName(source.path) };
      }
      const baseDir = await SherpaOnnx.resolveAppBaseDir(source.base);
      const fullPath = joinBaseAndRelativePath(baseDir, safeRelativePath);
      const modelDir = await resolveActualModelDir(fullPath);
      return { modelDir, assetName: deriveAssetName(source.path) };
    }

    case 'pad': {
      if (platformOs() !== 'android') {
        createFileIOError(
          FileIOErrorCode.UNSUPPORTED_ON_PLATFORM,
          'pad is supported on Android only.'
        );
      }
      const safeRelativePath = normalizeRelativePathForDetect(
        source.path,
        'pad'
      );
      const packPath = await SherpaOnnx.getAssetPackPath(source.packName);
      if (!packPath) {
        createFileIOError(
          FileIOErrorCode.RESOLVE_ERROR,
          `Play Asset Delivery pack not available: ${source.packName}`
        );
      }
      const fullPath = joinBaseAndRelativePath(packPath, safeRelativePath);
      const modelDir = await resolveActualModelDir(fullPath);
      return { modelDir, assetName: deriveAssetName(source.path) };
    }

    case 'contentUri':
      return { modelDir: '', assetName: deriveAssetNameFromUri(source.uri) };

    case 'securityScoped':
      return { modelDir: '', assetName: deriveAssetNameFromUri(source.uri) };
  }
}

async function resolveAutoFileSourceForDetect(source: {
  kind: 'auto';
  path: string;
  tryOrder: FileSourceAutoTryTarget[];
}): Promise<ResolvedDetectInput> {
  validateAutoFileSource(source);

  const attemptErrors: string[] = [];

  for (const target of source.tryOrder) {
    const label = autoTryTargetLabel(target);
    try {
      const concrete = fileSourceFromAutoTryTarget(target, source.path);
      const resolved = await resolveConcreteFileSourceForDetect(concrete);
      if (!(await isUsableModelDirectory(resolved.modelDir))) {
        attemptErrors.push(
          `${label}: directory not found (${resolved.modelDir})`
        );
        continue;
      }
      return resolved;
    } catch (error) {
      if (isFatalAutoResolveError(error)) {
        throw toFileIOResolveError(error);
      }
      const message = error instanceof Error ? error.message : String(error);
      attemptErrors.push(`${label}: ${message}`);
    }
  }

  createFileIOError(
    FileIOErrorCode.NOT_FOUND,
    `No FileSource location matched path "${
      source.path
    }". tryOrder=[${source.tryOrder
      .map(autoTryTargetLabel)
      .join(', ')}]. ${attemptErrors.join(' | ')}`
  );
}

/**
 * Resolve a {@link FileSource} into the `modelDir` + `assetName` required by
 * native detect methods.
 */
export async function resolveFileSourceForDetect(
  source: FileSource
): Promise<ResolvedDetectInput> {
  try {
    if (source.kind === 'auto') {
      return await resolveAutoFileSourceForDetect(source);
    }
    return await resolveConcreteFileSourceForDetect(source);
  } catch (error) {
    throw toFileIOResolveError(error);
  }
}

/**
 * Resolve a {@link FileSource} to a concrete local model directory for engine
 * initialization.
 */
export async function resolveFileSourceForModelInit(
  source: FileSource
): Promise<string> {
  if (source.kind === 'contentUri' || source.kind === 'securityScoped') {
    createFileIOError(
      FileIOErrorCode.UNSUPPORTED_ON_PLATFORM,
      `Model initialization does not support source kind '${source.kind}'. Use a directory-backed source such as 'fs', 'app', or 'pad'.`
    );
  }

  const resolved = await resolveFileSourceForDetect(source);
  const modelDir = resolved.modelDir.trim();
  if (modelDir.length > 0) {
    return modelDir;
  }

  createFileIOError(
    FileIOErrorCode.RESOLVE_ERROR,
    `Unable to resolve a local model directory for source kind '${source.kind}'.`
  );
}
