import type { ModelPathConfig } from '../types';

export type EnhancementModelType = 'gtcrn' | 'dpdfnet';

export const ENHANCEMENT_MODEL_TYPES: readonly EnhancementModelType[] = [
  'gtcrn',
  'dpdfnet',
] as const;

export type EnhancedAudio = {
  samples: Float32Array;
  sampleRate: number;
};

export interface EnhancementInitializeOptions {
  modelPath: ModelPathConfig;
  modelType?: EnhancementModelType | 'auto';
  numThreads?: number;
  provider?: string;
  debug?: boolean;
}

export type EnhancementDetectResult = {
  success: boolean;
  error?: string;
  detectedModels: Array<{ type: string; modelDir: string }>;
  modelType?: string;
};

export interface EnhancementEngine {
  readonly instanceId: string;
  enhanceFile(inputPath: string, outputPath?: string): Promise<EnhancedAudio>;
  enhanceSamples(samples: number[], sampleRate: number): Promise<EnhancedAudio>;
  getSampleRate(): Promise<number>;
  destroy(): Promise<void>;
}
