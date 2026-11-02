import SherpaOnnx from '../NativeSherpaOnnx';
import { resolvePipelineAudioBufferId } from '../audiobuffer';
import type { OfflineAudioBufferIdSource } from '../audiobuffer/types';

/**
 * After native Create, optionally lock VoxLock via the existing setter.
 * On failure the instance is unloaded so callers never receive a half-ready engine.
 */
export async function applyVoiceSampleAfterCreate(params: {
  instanceId: string;
  voiceSample: OfflineAudioBufferIdSource | undefined;
  unload: () => Promise<void>;
}): Promise<void> {
  if (params.voiceSample === undefined) {
    return;
  }
  try {
    const bufferId = resolvePipelineAudioBufferId(params.voiceSample);
    await SherpaOnnx.enhancementSetVoiceSample(params.instanceId, bufferId);
  } catch (err) {
    await params.unload().catch(() => undefined);
    throw err;
  }
}
