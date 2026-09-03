/**
 * Resolve FileSource paths for diarization init bridge options.
 */

import type { DiarizationInitializeOptions } from './types';
import type { DiarizationInitBridgeOptions } from '../NativeSherpaOnnx';
import { resolveFileSourceForModelInit } from '../detect/resolveModelInput';

export async function buildDiarizationInitBridgeOptions(
  options: DiarizationInitializeOptions
): Promise<DiarizationInitBridgeOptions> {
  const segmentationModel = await resolveFileSourceForModelInit(
    options.segmentation.modelSource
  );
  const embeddingModel = await resolveFileSourceForModelInit(
    options.embedding.modelSource
  );

  return {
    segmentationModel,
    embeddingModel,
    ...(options.segmentation.windowShiftRatio !== undefined
      ? { windowShiftRatio: options.segmentation.windowShiftRatio }
      : {}),
    ...(options.clustering?.numClusters !== undefined
      ? { numClusters: options.clustering.numClusters }
      : {}),
    ...(options.clustering?.threshold !== undefined
      ? { threshold: options.clustering.threshold }
      : {}),
    ...(options.minDurationOn !== undefined
      ? { minDurationOn: options.minDurationOn }
      : {}),
    ...(options.minDurationOff !== undefined
      ? { minDurationOff: options.minDurationOff }
      : {}),
    ...(options.numThreads !== undefined
      ? { numThreads: options.numThreads }
      : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.debug !== undefined ? { debug: options.debug } : {}),
  };
}
