import { TurboModuleRegistry } from 'react-native';
import type { Spec } from '../NativeSherpaOnnx';

type SherpaOnnxJSI = {
  getOfflineBufferSamples(
    bufferId: string,
    startFrame: number,
    frameCount: number
  ): ArrayBuffer;
  createOfflineFromSamples(
    samples: ArrayBuffer,
    sampleRate: number,
    channelCount: number
  ): string;
  getLiveBufferSamples(
    bufferId: string,
    startFrame: number,
    frameCount: number
  ): ArrayBuffer;
  appendSamplesToLive(
    liveBufferId: string,
    samples: ArrayBuffer,
    sampleRate: number
  ): void;
  takeVisualizationFrames(transferId: string): ArrayBuffer;
};

declare global {
  var __SherpaOnnxJSI: SherpaOnnxJSI | undefined;
}

const getNative = (): Spec =>
  TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');

let attemptedInstall = false;

export function isJSIAvailable(): boolean {
  return globalThis.__SherpaOnnxJSI != null;
}

export function installJSI(): boolean {
  if (isJSIAvailable()) {
    return true;
  }

  if (attemptedInstall) {
    return isJSIAvailable();
  }

  attemptedInstall = true;
  try {
    return getNative().installJSI() === true && isJSIAvailable();
  } catch {
    return false;
  }
}

export function requireJSI(): SherpaOnnxJSI {
  const jsi = globalThis.__SherpaOnnxJSI;
  if (jsi) {
    return jsi;
  }

  if (installJSI() && globalThis.__SherpaOnnxJSI) {
    return globalThis.__SherpaOnnxJSI;
  }

  throw new Error(
    '[JSI_NOT_INSTALLED] SherpaOnnx JSI bindings are not available. Ensure react-native >= 0.73 and module initialization completed.'
  );
}
