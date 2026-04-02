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
