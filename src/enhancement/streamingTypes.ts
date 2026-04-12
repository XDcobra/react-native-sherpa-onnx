import type { EnhancedAudio, EnhancementInitializeOptions } from './types';
import type { StreamingPipelineHandle } from '../audiobuffer/streamingPipelineTypes';

export type StreamingEnhancementInitializeOptions =
  EnhancementInitializeOptions;

export interface OnlineEnhancementEngine {
  readonly instanceId: string;
  feedSamples(samples: number[], sampleRate: number): Promise<EnhancedAudio>;
  flush(): Promise<EnhancedAudio>;
  reset(): Promise<void>;
  getSampleRate(): Promise<number>;
  getFrameShiftInSamples(): Promise<number>;
  destroy(): Promise<void>;
}

// ==================== Live Enhancement Pipeline ====================

/** Pipeline handle returned by `LiveEnhancementEngine.enhance()` — same controls as `StreamingPipelineHandle` plus the online denoiser `instanceId`. */
export interface EnhancementPipelineHandle extends StreamingPipelineHandle {
  /** Online enhancement engine instance driving this pipeline (`startEnhancementPipeline` first arg). */
  readonly instanceId: string;
}

export interface LiveEnhancementEngine extends OnlineEnhancementEngine {
  enhance(
    inputBufferId: string,
    outputBufferId: string
  ): Promise<EnhancementPipelineHandle>;
}
