import { resolveFileSourceForModelInit } from '../detect/resolveModelInput';
import type { OcrInitBridgeOptions } from '../NativeSherpaOnnx';
import type { OcrInitializeOptions, OcrModelType } from './types';

export type { OcrInitBridgeOptions };

export async function buildOcrInitBridgeOptions(
  options: OcrInitializeOptions
): Promise<OcrInitBridgeOptions> {
  const modelDir = await resolveFileSourceForModelInit(options.modelSource);
  const modelType: OcrModelType = options.modelType ?? 'auto';
  return {
    modelDir,
    modelType,
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
