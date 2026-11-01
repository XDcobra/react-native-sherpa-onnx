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

/**
 * Probe QNN (Qualcomm HTP) support on this device.
 *
 * @throws {Error} `QNN_SUPPORT_ERROR` — native QNN probe failed.
 */
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

/**
 * List ONNX Runtime execution providers compiled into this binary.
 *
 * @throws {Error} `PROVIDERS_ERROR` — native provider list failed.
 */
export function getAvailableProviders(): Promise<string[]> {
  return SherpaOnnx.getAvailableProviders();
}

/**
 * Probe NNAPI support on this device.
 *
 * @throws {Error} `NNAPI_SUPPORT_ERROR` — native NNAPI probe failed.
 */
export function getNnapiSupport(
  modelBase64?: string
): Promise<AccelerationSupport> {
  return SherpaOnnx.getNnapiSupport(modelBase64);
}

/**
 * Probe XNNPACK support on this device.
 *
 * @throws {Error} `XNNPACK_SUPPORT_ERROR` — native XNNPACK probe failed.
 */
export function getXnnpackSupport(
  modelBase64?: string
): Promise<AccelerationSupport> {
  return SherpaOnnx.getXnnpackSupport(modelBase64);
}

/**
 * Probe Core ML support on this device.
 *
 * @throws {Error} `COREML_SUPPORT_ERROR` — native Core ML probe failed.
 */
export function getCoreMlSupport(
  modelBase64?: string
): Promise<AccelerationSupport> {
  return SherpaOnnx.getCoreMlSupport(modelBase64);
}
