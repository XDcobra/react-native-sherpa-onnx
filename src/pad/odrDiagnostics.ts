/**
 * iOS ODR delivery diagnostics (__DEV__ only). Layout: `{tag}/models/`.
 * Content discovery: `listBundledArchives` / `listModelsAtPath` on `getAssetPackPath`.
 * @see docs/model-delivery-pad-odr.md
 */
import { Platform } from 'react-native';
import SherpaOnnx from '../NativeSherpaOnnx';

export type OdrDirectoryProbe = {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  entryCount: number;
  entries: string[];
};

export type OdrDeliverySnapshot = {
  tag: string;
  resolvedModelsPath: string | null;
  /** DEBUG native builds only */
  bundlePath?: string;
  resourcePath?: string;
  expectedModelsPath?: string;
  bundleSubdirectory?: string;
  hasActiveRequest?: boolean;
  isAccessingTag?: boolean;
  directoryProbe?: OdrDirectoryProbe;
};

function normalizeProbe(raw: Record<string, unknown>): OdrDirectoryProbe {
  return {
    path: String(raw.path ?? ''),
    exists: Boolean(raw.exists),
    isDirectory: Boolean(raw.isDirectory),
    entryCount: Number(raw.entryCount ?? 0),
    entries: Array.isArray(raw.entries) ? raw.entries.map(String) : [],
  };
}

function normalizeSnapshot(raw: Record<string, unknown>): OdrDeliverySnapshot {
  const resolved = raw.resolvedModelsPath;
  const probe = raw.directoryProbe;
  return {
    tag: String(raw.tag ?? ''),
    resolvedModelsPath:
      resolved == null || resolved === '' ? null : String(resolved),
    bundlePath: raw.bundlePath != null ? String(raw.bundlePath) : undefined,
    resourcePath:
      raw.resourcePath != null ? String(raw.resourcePath) : undefined,
    expectedModelsPath:
      raw.expectedModelsPath != null
        ? String(raw.expectedModelsPath)
        : undefined,
    bundleSubdirectory:
      raw.bundleSubdirectory != null
        ? String(raw.bundleSubdirectory)
        : undefined,
    hasActiveRequest:
      raw.hasActiveRequest != null ? Boolean(raw.hasActiveRequest) : undefined,
    isAccessingTag:
      raw.isAccessingTag != null ? Boolean(raw.isAccessingTag) : undefined,
    directoryProbe:
      probe && typeof probe === 'object'
        ? normalizeProbe(probe as Record<string, unknown>)
        : undefined,
  };
}

/** ODR delivery snapshot (path + access). Android: tag + null path. */
export async function listOdrDeliverySnapshot(
  tag: string
): Promise<OdrDeliverySnapshot> {
  if (Platform.OS !== 'ios') {
    return { tag, resolvedModelsPath: null };
  }
  const listNative = SherpaOnnx.listOdrDeliverySnapshot;
  if (typeof listNative !== 'function') {
    return { tag, resolvedModelsPath: null };
  }
  const raw = (await listNative.call(SherpaOnnx, tag)) as Record<
    string,
    unknown
  >;
  return normalizeSnapshot(raw);
}

/** Logs ODR delivery diagnostics in __DEV__. */
export async function logOdrDeliveryDiagnostics(tag: string): Promise<void> {
  if (!__DEV__ || Platform.OS !== 'ios') {
    return;
  }
  try {
    const snapshot = await listOdrDeliverySnapshot(tag);
    const path = snapshot.resolvedModelsPath ?? 'null';
    const expected = snapshot.expectedModelsPath ?? 'tag/models/';
    console.log(
      `[SherpaOnnx ODR] tag=${snapshot.tag} path=${path} expected=${expected} ` +
        `accessing=${snapshot.isAccessingTag ?? false} activeRequest=${
          snapshot.hasActiveRequest ?? false
        }`
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn('[SherpaOnnx ODR] delivery snapshot failed:', message);
  }
}
