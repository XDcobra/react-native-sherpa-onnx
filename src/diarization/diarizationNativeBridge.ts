/**
 * Resolve FileSource paths for diarization init bridge options.
 */

import type { DiarizationInitializeOptions } from './types';
import type { DiarizationInitBridgeOptions } from '../NativeSherpaOnnx';
import type { FileSource } from '../fileio/types';
import { resolveFileSourceForModelInit } from '../detect/resolveModelInput';
import { detectDiarizationModel } from './detectDiarizationModel';
import { detectSpeakerEmbeddingModel } from '../speaker-embedding';

async function resolveModelFilePath(
  source: FileSource,
  detectFn: (
    src: FileSource
  ) => Promise<{ success: boolean; paths?: { model?: string } }>
): Promise<string> {
  const resolved = await resolveFileSourceForModelInit(source);
  if (
    resolved.toLowerCase().endsWith('.onnx') ||
    resolved.toLowerCase().endsWith('.ort')
  ) {
    return resolved;
  }
  try {
    const det = await detectFn(source);
    if (det.success && det.paths?.model) {
      return det.paths.model;
    }
  } catch {
    // fallback to resolved path
  }
  return resolved;
}

export async function buildDiarizationInitBridgeOptions(
  options: DiarizationInitializeOptions
): Promise<DiarizationInitBridgeOptions> {
  const segmentationModel = await resolveModelFilePath(
    options.segmentation.modelSource,
    detectDiarizationModel
  );
  const embeddingModel = await resolveModelFilePath(
    options.embedding.modelSource,
    detectSpeakerEmbeddingModel
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
