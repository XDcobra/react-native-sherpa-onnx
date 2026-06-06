/**
 * Re-exports TurboModule init bridge types from `NativeSherpaOnnx.ts` (codegen source of truth).
 * Use this path from `*NativeBridge.ts` builders so imports stay out of the TurboModule spec file.
 */

export type {
  OnlineSttInitBridgeOptions,
  SttInitBridgeOptions,
  TtsInitBridgeOptions,
  VadInitBridgeOptions,
} from '../NativeSherpaOnnx';
