import SherpaOnnx from './NativeSherpaOnnx';

/**
 * Execution-provider probes and related types. Import from `react-native-sherpa-onnx/provider`.
 */

/** Unified shape for all acceleration backends (QNN, NNAPI, XNNPACK, Core ML). */
export type AccelerationSupport = {
  providerCompiled: boolean;
  hasAccelerator: boolean;
  canInit: boolean;
};

export function getQnnSupport(
  modelBase64?: string
): Promise<AccelerationSupport> {
  return SherpaOnnx.getQnnSupport(modelBase64);
}

export type DeviceQnnSocResult = {
  soc: string | null;
  isSupported: boolean;
};

export function getDeviceQnnSoc(): Promise<DeviceQnnSocResult> {
  return SherpaOnnx.getDeviceQnnSoc();
}

export function getAvailableProviders(): Promise<string[]> {
  return SherpaOnnx.getAvailableProviders();
}

export function getNnapiSupport(
  modelBase64?: string
): Promise<AccelerationSupport> {
  return SherpaOnnx.getNnapiSupport(modelBase64);
}

export function getXnnpackSupport(
  modelBase64?: string
): Promise<AccelerationSupport> {
  return SherpaOnnx.getXnnpackSupport(modelBase64);
}

export function getCoreMlSupport(
  modelBase64?: string
): Promise<AccelerationSupport> {
  return SherpaOnnx.getCoreMlSupport(modelBase64);
}
