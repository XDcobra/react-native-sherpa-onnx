import type { ModelPathConfig } from '../types';

/**
 * Keyword spotting model types.
 * These models use KeywordSpotter + OnlineStream in sherpa-onnx.
 */
export type KwsModelType = 'transducer';

/** Runtime list of supported KWS model types. */
export const KWS_MODEL_TYPES: readonly KwsModelType[] = ['transducer'] as const;

/**
 * Options for initializing the keyword spotting engine.
 */
export interface KwsInitOptions {
  /** Model path configuration (asset, file, or auto). */
  modelPath: ModelPathConfig;
  /** KWS model type. Default: 'transducer'. Only 'transducer' is supported. */
  modelType?: KwsModelType;
  /** Path to keywords file (resolved against modelDir if relative). */
  keywordsPath?: ModelPathConfig;
  /** Keywords score boost. Default: 1.5 (Kotlin), 1.0 (CXX). */
  keywordsScore?: number;
  /** Keywords detection threshold. Default: 0.25. */
  keywordsThreshold?: number;
  /** Trailing blank frames required before fire (lower = sooner). Default: 2 (Kotlin), 1 (CXX). */
  numTrailingBlanks?: number;
  /** Max active paths for decoder (beam width). Default: 4. */
  maxActivePaths?: number;
  /** Number of threads for inference. Default: 1. */
  numThreads?: number;
  /** Execution provider (e.g. "cpu", "coreml", "nnapi", "xnnpack"). */
  provider?: string;
  /** Enable debug logging. Default: false. */
  debug?: boolean;
}

/**
 * Keyword detection result.
 */
export interface KwsResult {
  /** Detected keyword name (empty string if no detection). */
  keyword: string;
  /** Tokens that matched. */
  tokens: string[];
  /** Timestamps of tokens. */
  timestamps: number[];
}

/**
 * Keyword spotting stream. Created by KeywordSpotterEngine.createStream().
 * Feeds audio via acceptWaveform, then decode / getResult.
 */
export interface KwsStream {
  readonly streamId: string;

  /** Feed PCM samples (float in [-1, 1]) to the stream. */
  acceptWaveform(samples: number[], sampleRate: number): Promise<void>;

  /** Run decoding on accumulated audio (call when isReady() is true). */
  decode(): Promise<void>;

  /** True if there is enough audio to decode. */
  isReady(): Promise<boolean>;

  /** Get current detection result. Call after decode(). */
  getResult(): Promise<KwsResult>;

  /** Reset stream state for reuse. */
  reset(): Promise<void>;

  /** Release native stream; do not use after this. */
  release(): Promise<void>;

  /**
   * Convenience: feed audio, auto-decode while ready, return result.
   * Automatically resets stream if keyword is detected.
   * Reduces bridge round-trips from 4 to 1 per chunk.
   */
  processAudioChunk(
    samples: number[] | Float32Array,
    sampleRate: number
  ): Promise<KwsResult>;
}

/**
 * Keyword spotting engine (KeywordSpotter). Create via createKeywordSpotter().
 */
export interface KeywordSpotterEngine {
  readonly instanceId: string;

  /** Create a new stream for this spotter. Optional keywords string. */
  createStream(keywords?: string): Promise<KwsStream>;

  /** Release native spotter and all streams. */
  destroy(): Promise<void>;
}
