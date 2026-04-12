import type { ModelPathConfig } from '../types';
import type { EnhancementDetectModelResult } from '../types/modelDetect';
import type { OfflineAudioBufferIdSource } from '../audiobuffer/types';

export {
  DETECTION_SOURCES,
  isDetectionSource,
  type DetectionSource,
  type DetectedModelEntry,
  type EnhancementDetectModelResult,
  type ModelDetectResultBase,
} from '../types/modelDetect';

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

export type EnhancementDetectResult = EnhancementDetectModelResult;

export interface EnhancementEngine {
  readonly instanceId: string;
  /**
   * Read-only input offline buffer; writes denoised PCM into empty `audioOut`.
   * Both arguments must resolve to offline audio buffer ids (`off_*`).
   * `audioIn` must be populated; `audioOut` must be empty (created via `createEmptyOfflineAudioBuffer`).
   */
  enhance(
    audioIn: OfflineAudioBufferIdSource,
    audioOut: OfflineAudioBufferIdSource
  ): Promise<void>;
  getSampleRate(): Promise<number>;
  destroy(): Promise<void>;
}
