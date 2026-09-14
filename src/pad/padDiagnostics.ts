/**
 * Android PAD bridge probe (__DEV__ / ensure failure paths).
 * @see docs/model-delivery-pad-odr.md
 */
import SherpaOnnx from '../NativeSherpaOnnx';

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
