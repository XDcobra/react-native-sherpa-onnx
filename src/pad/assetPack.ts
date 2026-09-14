/**
 * Ship model delivery — Android PAD (install-time / fast-follow / on-demand) & iOS ODR.
 * Re-exported from `react-native-sherpa-onnx/utils`.
 * Prefer {@link ensureAssetPackReady} over bare {@link fetchAssetPack} for app readiness.
 * @see docs/model-delivery-pad-odr.md
 */
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import SherpaOnnx from '../NativeSherpaOnnx';
import { probePadNativeBridge } from './padDiagnostics';

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

/** Classified reason for PAD/ODR ensure failures (app resume / UI). */
export type AssetPackDeliveryFailureReason =
  | 'network'
  | 'background_denied'
  | 'play_unavailable'
  | 'stalled'
  | 'wifi'
  | 'insufficient_storage'
  | 'unknown';

export type AssetPackDeliveryError = Error & {
  deliveryReason: AssetPackDeliveryFailureReason;
  nativeCode?: string;
  errorCode?: number;
};

const JS_ENSURE_TIMEOUT_MS = 90_000;

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
  if (state.status === 'completed') {
    return 100;
  }
  if (state.totalBytes <= 0 || state.bytesDownloaded <= 0) {
    return null;
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

type NativeEnsureRaw = {
  packName: string;
  status: string;
  bytesDownloaded: number;
  totalBytes: number;
  errorCode: number;
};

/** TurboModule first, then NativeModules (same native listener implementation). */
function resolveNativeEnsureAssetPackReady():
  | ((packName: string) => Promise<NativeEnsureRaw>)
  | null {
  if (typeof SherpaOnnx.ensureAssetPackReady === 'function') {
    return SherpaOnnx.ensureAssetPackReady.bind(SherpaOnnx);
  }
  const legacy = NativeModules.SherpaOnnx as
    | { ensureAssetPackReady?: (packName: string) => Promise<NativeEnsureRaw> }
    | undefined;
  if (typeof legacy?.ensureAssetPackReady === 'function') {
    return legacy.ensureAssetPackReady.bind(legacy);
  }
  return null;
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

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
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

  const nativeEnsure = resolveNativeEnsureAssetPackReady();
  if (!nativeEnsure) {
    const bridge = probePadNativeBridge();
    const message =
      `SherpaOnnx.ensureAssetPackReady is not available on the native module. ` +
      `Rebuild and reinstall the app with the SherpaOnnx native library linked. ` +
      `bridge=${JSON.stringify(bridge)}`;
    if (__DEV__) {
      console.warn(
        '[SherpaOnnx PAD] ensureAssetPackReady unavailable:',
        message
      );
    }
    throw classifyAssetPackDeliveryError(new Error(message), packName);
  }

  try {
    const raw = await withTimeout(
      nativeEnsure(packName),
      JS_ENSURE_TIMEOUT_MS,
      () => {
        const err = new Error(
          `On-demand delivery stalled for "${packName}" (JS timeout ${JS_ENSURE_TIMEOUT_MS}ms)`
        );
        (err as AssetPackDeliveryError).name = 'PAD_STALLED';
        return err;
      }
    );
    const state = normalizeSnapshot(raw);
    options?.onProgress?.(state, assetPackDownloadPercent(state));
    return state;
  } catch (error) {
    throw classifyAssetPackDeliveryError(error, packName);
  } finally {
    progressHandlersByPack.delete(packName);
  }
}

/**
 * Map native/JS ensure failures to a stable {@link AssetPackDeliveryFailureReason}.
 */
export function classifyAssetPackDeliveryFailure(
  error: unknown
): AssetPackDeliveryFailureReason {
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (
      typeof record.deliveryReason === 'string' &&
      isDeliveryReason(record.deliveryReason)
    ) {
      return record.deliveryReason;
    }
  }
  const code =
    error instanceof Error
      ? error.name
      : error &&
        typeof error === 'object' &&
        typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : '';
  const message =
    error instanceof Error
      ? error.message
      : error &&
        typeof error === 'object' &&
        typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : String(error ?? '');
  const haystack = `${code} ${message}`.toLowerCase();

  if (
    haystack.includes('pad_play_unavailable') ||
    haystack.includes('play_store') ||
    haystack.includes('play store') ||
    haystack.includes('api_not_available') ||
    haystack.includes('binder has died') ||
    haystack.includes('app_unavailable')
  ) {
    return 'play_unavailable';
  }
  if (
    haystack.includes('pad_access_denied') ||
    haystack.includes('access_denied') ||
    haystack.includes('access denied') ||
    haystack.includes('errorcode=-7') ||
    haystack.includes('errorcode= -7') ||
    /\(errorcode=-7\)/.test(haystack)
  ) {
    return 'background_denied';
  }
  if (
    haystack.includes('pad_network') ||
    haystack.includes('network_error') ||
    haystack.includes('network error') ||
    haystack.includes('errorcode=-6')
  ) {
    return 'network';
  }
  if (
    haystack.includes('pad_stalled') ||
    haystack.includes('odr_stalled') ||
    haystack.includes('stalled')
  ) {
    return 'stalled';
  }
  if (
    haystack.includes('waiting_for_wifi') ||
    haystack.includes('wifi') ||
    haystack.includes('confirmation')
  ) {
    return 'wifi';
  }
  if (
    haystack.includes('insufficient_storage') ||
    haystack.includes('insufficient storage')
  ) {
    return 'insufficient_storage';
  }
  return 'unknown';
}

function isDeliveryReason(
  value: string
): value is AssetPackDeliveryFailureReason {
  return (
    value === 'network' ||
    value === 'background_denied' ||
    value === 'play_unavailable' ||
    value === 'stalled' ||
    value === 'wifi' ||
    value === 'insufficient_storage' ||
    value === 'unknown'
  );
}

export function isRetryableAssetPackFailure(
  reason: AssetPackDeliveryFailureReason
): boolean {
  return (
    reason === 'network' ||
    reason === 'stalled' ||
    reason === 'background_denied' ||
    reason === 'wifi'
  );
}

function classifyAssetPackDeliveryError(
  error: unknown,
  packName: string
): AssetPackDeliveryError {
  const base = normalizeAssetPackDeliveryError(error, packName);
  const reason = classifyAssetPackDeliveryFailure(base);
  const classified = base as AssetPackDeliveryError;
  classified.deliveryReason = reason;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (typeof record.code === 'string') {
      classified.nativeCode = record.code;
    }
  }
  if (__DEV__) {
    console.warn(
      `[SherpaOnnx PAD] classify pack=${packName} reason=${reason} code=${classified.name} msg=${classified.message}`
    );
  }
  return classified;
}

function normalizeAssetPackDeliveryError(
  error: unknown,
  packName: string
): Error {
  if (error instanceof Error) {
    const msg = error.message;
    if (typeof msg === 'string' && msg.trim().length > 0) {
      return error;
    }
  }
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const msg = record.message;
    const code = record.code;
    const text =
      (typeof msg === 'string' && msg.trim().length > 0
        ? msg
        : typeof code === 'string' && code.trim().length > 0
        ? code
        : null) ?? `On-demand delivery failed for "${packName}"`;
    const wrapped = new Error(text);
    if (typeof code === 'string' && code.length > 0) {
      wrapped.name = code;
    }
    return wrapped;
  }
  return new Error(`On-demand delivery failed for "${packName}"`);
}
