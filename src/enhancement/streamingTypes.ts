import type { EnhancedAudio, EnhancementInitializeOptions } from './types';

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

export interface StreamingPipelineStatus {
  pipelineId: string;
  isRunning: boolean;
  chunksProcessed: number;
  samplesRead: number;
  samplesWritten: number;
  error: string | null;
}

export interface StreamingPipelineHandle {
  readonly pipelineId: string;
  stop(): Promise<void>;
  flush(): Promise<void>;
  reset(): Promise<void>;
  getStatus(): Promise<StreamingPipelineStatus>;
}

export interface LiveEnhancementEngine extends OnlineEnhancementEngine {
  enhance(
    inputBufferId: string,
    outputBufferId: string
  ): Promise<StreamingPipelineHandle>;
}
