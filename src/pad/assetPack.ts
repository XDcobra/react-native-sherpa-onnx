/**
 * Ship model delivery — Android PAD (install-time / fast-follow / on-demand) & iOS ODR.
 * Re-exported from `react-native-sherpa-onnx/utils`.
 * @see docs/model-delivery-pad-odr.md
 */
import { Platform } from 'react-native';
import SherpaOnnx from '../NativeSherpaOnnx';

export type AssetPackDeliveryStatus =
  | 'unknown'
  | 'pending'
  | 'downloading'
  | 'transferring'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'waiting_for_wifi'
  | 'not_installed';

export type AssetPackStateSnapshot = {
  packName: string;
  status: AssetPackDeliveryStatus;
  bytesDownloaded: number;
  totalBytes: number;
  errorCode: number;
};

const TERMINAL: ReadonlySet<AssetPackDeliveryStatus> = new Set([
  'completed',
  'failed',
  'canceled',
  'not_installed',
]);

function normalizeStatus(raw: string): AssetPackDeliveryStatus {
  const s = raw.toLowerCase() as AssetPackDeliveryStatus;
  if (
    s === 'pending' ||
    s === 'downloading' ||
    s === 'transferring' ||
    s === 'completed' ||
    s === 'failed' ||
    s === 'canceled' ||
    s === 'waiting_for_wifi' ||
    s === 'not_installed'
  ) {
    return s;
  }
  return 'unknown';
}

export async function fetchAssetPack(packName: string): Promise<boolean> {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
    return false;
  }
  return SherpaOnnx.fetchAssetPack(packName);
}

export async function getAssetPackState(
  packName: string
): Promise<AssetPackStateSnapshot> {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
    return {
      packName,
      status: 'not_installed',
      bytesDownloaded: 0,
      totalBytes: 0,
      errorCode: 0,
    };
  }
  const raw = await SherpaOnnx.getAssetPackState(packName);
  return {
    packName: raw.packName,
    status: normalizeStatus(raw.status),
    bytesDownloaded: raw.bytesDownloaded,
    totalBytes: raw.totalBytes,
    errorCode: raw.errorCode,
  };
}

export async function removeAssetPack(packName: string): Promise<number> {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
    return 0;
  }
  return SherpaOnnx.removeAssetPack(packName);
}

export function assetPackDownloadPercent(
  state: AssetPackStateSnapshot
): number | null {
  if (state.totalBytes <= 0) {
    return state.status === 'completed' ? 100 : null;
  }
  return Math.min(
    100,
    Math.round((state.bytesDownloaded / state.totalBytes) * 100)
  );
}

export type WaitForAssetPackOptions = {
  pollIntervalMs?: number;
  onProgress?: (state: AssetPackStateSnapshot, percent: number | null) => void;
};

/**
 * Starts fetch (if needed) and polls until the pack/tag is ready on disk or fails.
 * Android: Play Asset Delivery on-demand pack. iOS: On-Demand Resources tag.
 */
export async function waitForAssetPackReady(
  packName: string,
  options?: WaitForAssetPackOptions
): Promise<AssetPackStateSnapshot> {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
    throw new Error(
      'On-demand model delivery is only available on Android and iOS'
    );
  }

  const pollMs = options?.pollIntervalMs ?? 500;
  let location = await SherpaOnnx.getAssetPackPath(packName);
  if (location == null || location.length === 0) {
    await fetchAssetPack(packName);
  }

  for (;;) {
    const state = await getAssetPackState(packName);
    const percent = assetPackDownloadPercent(state);
    options?.onProgress?.(state, percent);

    if (state.status === 'completed') {
      location = await SherpaOnnx.getAssetPackPath(packName);
      if (location != null && location.length > 0) {
        return state;
      }
    }

    if (state.status === 'failed' || state.status === 'canceled') {
      throw new Error(
        `Asset pack ${packName} ${state.status} (errorCode=${state.errorCode})`
      );
    }

    if (TERMINAL.has(state.status) && state.status !== 'completed') {
      throw new Error(`Asset pack ${packName} not available (${state.status})`);
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }
}
