/**
 * Android PAD delivery diagnostics (__DEV__ only).
 * @see docs/model-delivery-pad-odr.md
 */
import { Platform } from 'react-native';
import SherpaOnnx from '../NativeSherpaOnnx';
import { getAssetPackState } from './assetPack';

export type PadNativeBridgeProbe = {
  ensureAssetPackReady: boolean;
  fetchAssetPack: boolean;
  getAssetPackPath: boolean;
  getAssetPackState: boolean;
  removeAssetPack: boolean;
};

/** Which PAD TurboModule methods are present on the native bridge. */
export function probePadNativeBridge(): PadNativeBridgeProbe {
  return {
    ensureAssetPackReady: typeof SherpaOnnx.ensureAssetPackReady === 'function',
    fetchAssetPack: typeof SherpaOnnx.fetchAssetPack === 'function',
    getAssetPackPath: typeof SherpaOnnx.getAssetPackPath === 'function',
    getAssetPackState: typeof SherpaOnnx.getAssetPackState === 'function',
    removeAssetPack: typeof SherpaOnnx.removeAssetPack === 'function',
  };
}

/**
 * Logs bridge availability and pack state when delivery fails (__DEV__ only).
 * Path resolution details are emitted by native `getAssetPackPath`.
 */
export async function logPadDeliveryDiagnostics(
  packName: string
): Promise<void> {
  if (!__DEV__ || Platform.OS !== 'android') {
    return;
  }
  const bridge = probePadNativeBridge();
  if (!bridge.ensureAssetPackReady) {
    console.warn(
      '[SherpaOnnx PAD] ensureAssetPackReady missing on native module — ' +
        'rebuild and reinstall the app with SherpaOnnx linked. ' +
        `bridge=${JSON.stringify(bridge)}`
    );
    return;
  }
  try {
    const state = await getAssetPackState(packName);
    if (state.status !== 'completed') {
      console.log(
        `[SherpaOnnx PAD] pack=${packName} status=${state.status} ` +
          `bytes=${state.bytesDownloaded}/${state.totalBytes} errorCode=${state.errorCode}`
      );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn('[SherpaOnnx PAD] getAssetPackState failed:', message);
  }
}
