import type { EnhancementInitializeOptions } from './types';
import type { StreamingPipelineHandle } from '../audiobuffer/streamingPipelineTypes';

export type StreamingEnhancementInitializeOptions =
  EnhancementInitializeOptions;

/**
 * Online denoiser from `createStreamingEnhancement`. Audio is produced only via
 * `enhance` into a `LiveAudioBuffer` (native worker); read results from the output buffer.
 */
export interface StreamingEnhancementEngine {
  readonly instanceId: string;
  getSampleRate(): Promise<number>;
  getFrameShiftInSamples(): Promise<number>;
  destroy(): Promise<void>;
  enhance(
    inputBufferId: string,
    outputBufferId: string
  ): Promise<EnhancementPipelineHandle>;
}

/** Pipeline handle returned by `StreamingEnhancementEngine.enhance()` — same controls as `StreamingPipelineHandle` plus the online denoiser `instanceId`. */
export interface EnhancementPipelineHandle extends StreamingPipelineHandle {
  /** Online enhancement engine instance driving this pipeline (`startEnhancementPipeline` first arg). */
  readonly instanceId: string;
}
