import type {
  EnhanceSegmentationConfig,
  EnhancementInitializeOptions,
} from './types';
import type { OfflineAudioBufferIdSource } from '../audiobuffer/types';
import type { StreamingPipelineHandle } from '../audiobuffer/streamingPipelineTypes';

export type StreamingEnhancementInitializeOptions =
  EnhancementInitializeOptions;

export interface StreamingEnhancementEnhanceOptions {
  segmentation?: EnhanceSegmentationConfig;
}

/**
 * Online denoiser from `createStreamingEnhancement`. Audio is produced only via
 * `enhance` into a `LiveAudioBuffer` (native worker); read results from the output buffer.
 */
export interface StreamingEnhancementEngine {
  readonly instanceId: string;
  getSampleRate(): Promise<number>;
  getFrameShiftInSamples(): Promise<number>;
  /**
   * Lock a VoxLock online engine to a specific voice from an offline PCM buffer.
   * Same contract as `EnhancementEngine.setVoiceSample`.
   */
  setVoiceSample(buffer: OfflineAudioBufferIdSource): Promise<void>;
  destroy(): Promise<void>;
  /**
   * Start an online denoise pipeline from a live input buffer into a live output buffer.
   * @throws {Error} `ENHANCEMENT_INVALID_ARGUMENT` — `inputBufferId` is not a `live_*` audio buffer.
   * @throws {Error} `ENHANCEMENT_INVALID_SEGMENTATION` — segmentation policy is invalid for online enhance.
   * @throws {Error} `ONLINE_ENHANCEMENT_ERROR` — native online enhance failed.
   * @throws {Error} `ENHANCEMENT_PIPELINE_BUFFER_NOT_FOUND` — live buffer is unknown.
   * @throws {Error} `AUDIO_BUFFER_NOT_FOUND` — audio buffer is not in the native registry.
   * @throws {Error} `BUFFER_INVALIDATED` — a live buffer was released while the pipeline ran.
   * @throws {Error} `STREAMING_PIPELINE_ERROR` — native pipeline worker failed.
   */
  enhance(
    inputBufferId: string,
    outputBufferId: string,
    options?: StreamingEnhancementEnhanceOptions
  ): Promise<EnhancementPipelineHandle>;
}

/** Pipeline handle returned by `StreamingEnhancementEngine.enhance()` — same controls as `StreamingPipelineHandle` plus the online denoiser `instanceId`. */
export interface EnhancementPipelineHandle extends StreamingPipelineHandle {
  /** Online enhancement engine instance driving this pipeline (`startEnhancementPipeline` first arg). */
  readonly instanceId: string;
}
