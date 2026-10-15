import { resolveFileSourceForModelInit } from '../detect/resolveModelInput';
import type { OcrInitializeOptions } from './types';

export type OcrInitBridgeOptions = {
  modelDir: string;
  modelType: string;
  numThreads?: number;
  provider?: string;
  maxSideLen?: number;
  useOrientationCls?: boolean;
};

export async function buildOcrInitBridgeOptions(
  options: OcrInitializeOptions
): Promise<OcrInitBridgeOptions> {
  const modelDir = await resolveFileSourceForModelInit(options.modelSource);
  return {
    modelDir,
    modelType: options.modelType ?? 'auto',
    ...(options.numThreads !== undefined
      ? { numThreads: options.numThreads }
      : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.ppocr?.maxSideLen !== undefined
      ? { maxSideLen: options.ppocr.maxSideLen }
      : {}),
    ...(options.ppocr?.useOrientationCls !== undefined
      ? { useOrientationCls: options.ppocr.useOrientationCls }
      : {}),
  };
}
