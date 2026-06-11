import SherpaOnnx from '../NativeSherpaOnnx';
import { resolvePipelineAudioBufferId } from '../audiobuffer';
import type { OfflineAudioBufferIdSource } from '../audiobuffer/types';
import type { SeparateOptions, SeparationResult } from './types';

/** Single batch call — used by MVP and later as orchestrator primitive. */
export async function runOfflineSeparationDirect(
  instanceId: string,
  audioIn: OfflineAudioBufferIdSource,
  audioOuts: readonly OfflineAudioBufferIdSource[]
): Promise<void> {
  const inId = resolvePipelineAudioBufferId(audioIn);
  const outIds = audioOuts.map(resolvePipelineAudioBufferId);
  await SherpaOnnx.separateOfflineAudioBuffers(instanceId, inId, outIds);
}

/**
 * Segment-wise separation into N output buffers — NOT implemented in MVP.
 * Future: mirror runOfflineEnhancementPipeline; per segment call
 * separateOfflineAudioBuffers with slice/sub-buffers; sync all N stems.
 */
export async function runOfflineSeparationPipeline(
  _audioIn: OfflineAudioBufferIdSource,
  _instanceId: string,
  _audioOuts: readonly OfflineAudioBufferIdSource[],
  _options: SeparateOptions = {}
): Promise<SeparationResult> {
  throw new Error(
    'Separation segmentation orchestration is not implemented yet'
  );
}
