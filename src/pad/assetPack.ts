/**
 * Ship model delivery — Android PAD (install-time / fast-follow / on-demand) & iOS ODR.
 * Re-exported from `react-native-sherpa-onnx/utils`.
 * @see docs/model-delivery-pad-odr.md
 */
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
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

function normalizeSnapshot(raw: {
  packName: string;
  status: string;
  bytesDownloaded: number;
  totalBytes: number;
  errorCode: number;
}): AssetPackStateSnapshot {
  return {
    packName: raw.packName,
    status: normalizeStatus(raw.status),
    bytesDownloaded: raw.bytesDownloaded,
    totalBytes: raw.totalBytes,
    errorCode: raw.errorCode,
  };
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
  return normalizeSnapshot(raw);
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

export type EnsureAssetPackReadyOptions = {
  onProgress?: (state: AssetPackStateSnapshot, percent: number | null) => void;
};

type ProgressHandler = (
  state: AssetPackStateSnapshot,
  percent: number | null
) => void;

const progressHandlersByPack = new Map<string, ProgressHandler>();
let progressListenersInstalled = false;

function getEmitter(): NativeEventEmitter {
  return new NativeEventEmitter(NativeModules.SherpaOnnx as any);
}

function ensureProgressListeners(): void {
  if (progressListenersInstalled) {
    return;
  }
  progressListenersInstalled = true;
  getEmitter().addListener(
    'sherpaAssetPackDeliveryProgress',
    (event: {
      packName?: string;
      status?: string;
      bytesDownloaded?: number;
      totalBytes?: number;
      errorCode?: number;
    }) => {
      const packName = event?.packName;
      if (!packName) {
        return;
      }
      const handler = progressHandlersByPack.get(packName);
      if (!handler) {
        return;
      }
      const state = normalizeSnapshot({
        packName,
        status: event.status ?? 'unknown',
        bytesDownloaded: event.bytesDownloaded ?? 0,
        totalBytes: event.totalBytes ?? 0,
        errorCode: event.errorCode ?? 0,
      });
      handler(state, assetPackDownloadPercent(state));
    }
  );
}

/**
 * Native fetch + listener until the pack/tag is ready (Android: COMPLETED; iOS: models path on disk).
 */
export async function ensureAssetPackReady(
  packName: string,
  options?: EnsureAssetPackReadyOptions
): Promise<AssetPackStateSnapshot> {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
    throw new Error(
      'On-demand model delivery is only available on Android and iOS'
    );
  }

  ensureProgressListeners();
  if (options?.onProgress) {
    progressHandlersByPack.set(packName, options.onProgress);
  }

  try {
    const raw = await SherpaOnnx.ensureAssetPackReady(packName);
    const state = normalizeSnapshot(raw);
    options?.onProgress?.(state, assetPackDownloadPercent(state));
    return state;
  } finally {
    progressHandlersByPack.delete(packName);
  }
}
