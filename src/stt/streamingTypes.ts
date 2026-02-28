import type { ModelPathConfig } from '../types';

/**
 * Online (streaming) STT model types.
 * These models use OnlineRecognizer + OnlineStream in sherpa-onnx.
 * Must match the native OnlineRecognizer model config (transducer, paraformer, zipformer2_ctc, nemo_ctc, tone_ctc).
 */
export type OnlineSTTModelType =
  | 'transducer'
  | 'paraformer'
  | 'zipformer2_ctc'
  | 'nemo_ctc'
  | 'tone_ctc';

/** Runtime list of supported online STT model types. */
export const ONLINE_STT_MODEL_TYPES: readonly OnlineSTTModelType[] = [
  'transducer',
  'paraformer',
  'zipformer2_ctc',
  'nemo_ctc',
  'tone_ctc',
] as const;

/**
 * Single endpoint rule (Kotlin EndpointRule).
 * Used to detect end of utterance in streaming recognition.
 */
export interface EndpointRule {
  /** If true, rule only matches when the segment contains non-silence. */
  mustContainNonSilence: boolean;
  /** Minimum trailing silence in seconds. */
  minTrailingSilence: number;
  /** Minimum utterance length in seconds (e.g. max length cap). */
  minUtteranceLength: number;
}

/**
 * Endpoint detection config (Kotlin EndpointConfig).
 * Three rules; first match determines end of utterance.
 */
export interface EndpointConfig {
  /** Rule 1: e.g. 2.4s trailing silence, no speech required. */
  rule1?: EndpointRule;
  /** Rule 2: e.g. 1.4s trailing silence, speech required. */
  rule2?: EndpointRule;
  /** Rule 3: e.g. max utterance length 20s. */
  rule3?: EndpointRule;
}

/**
 * Options for initializing the streaming (online) STT engine.
 */
export interface StreamingSttInitOptions {
  /** Model path configuration (asset, file, or auto). */
  modelPath: ModelPathConfig;
  /** Online model type. Use 'auto' to detect from model directory (calls detectSttModel and maps to an online type). */
  modelType: OnlineSTTModelType | 'auto';
  /** Enable endpoint detection. Default: true. */
  enableEndpoint?: boolean;
  /** Endpoint rules. Defaults match Kotlin (rule1: 2.4s silence, rule2: 1.4s + speech, rule3: 20s max). */
  endpointConfig?: EndpointConfig;
  /** Decoding method. Default: "greedy_search". */
  decodingMethod?: 'greedy_search' | 'modified_beam_search';
  /** Max active paths for beam search. Default: 4. */
  maxActivePaths?: number;
  /** Path to hotwords file (transducer/nemo_transducer). */
  hotwordsFile?: string;
  /** Hotwords score. Default: 1.5. */
  hotwordsScore?: number;
  /** Number of threads for inference. Default: 1. */
  numThreads?: number;
  /** Execution provider (e.g. "cpu"). */
  provider?: string;
  /** Path(s) to rule FSTs for ITN. */
  ruleFsts?: string;
  /** Path(s) to rule FARs for ITN. */
  ruleFars?: string;
  /** Blank penalty. */
  blankPenalty?: number;
  /** Enable debug logging. Default: false. */
  debug?: boolean;
}

/**
 * Partial or final recognition result from streaming STT (maps to Kotlin OnlineRecognizerResult).
 */
export interface StreamingSttResult {
  text: string;
  tokens: string[];
  timestamps: number[];
}

/**
 * Streaming STT stream. Created by StreamingSttEngine.createStream().
 * Feeds audio via acceptWaveform, then decode / getResult / isEndpoint.
 */
export interface SttStream {
  readonly streamId: string;

  /** Feed PCM samples (float in [-1, 1]) to the stream. */
  acceptWaveform(samples: number[], sampleRate: number): Promise<void>;

  /** Signal that no more audio will be fed. */
  inputFinished(): Promise<void>;

  /** Run decoding on accumulated audio (call when isReady() is true). */
  decode(): Promise<void>;

  /** True if there is enough audio to decode. */
  isReady(): Promise<boolean>;

  /** Get current partial or final result. Call after decode(). */
  getResult(): Promise<StreamingSttResult>;

  /** True if endpoint (end of utterance) was detected. */
  isEndpoint(): Promise<boolean>;

  /** Reset stream state for reuse. */
  reset(): Promise<void>;

  /** Release native stream; do not use after this. */
  release(): Promise<void>;

  /**
   * Convenience: feed audio, auto-decode while ready, return result and endpoint status.
   * Reduces bridge round-trips from 5 to 1 per chunk.
   */
  processAudioChunk(
    samples: number[],
    sampleRate: number
  ): Promise<{ result: StreamingSttResult; isEndpoint: boolean }>;
}

/**
 * Streaming STT engine (OnlineRecognizer). Create via createStreamingSTT().
 */
export interface StreamingSttEngine {
  readonly instanceId: string;

  /** Create a new stream for this recognizer. Optional hotwords string. */
  createStream(hotwords?: string): Promise<SttStream>;

  /** Release native recognizer and all streams. */
  destroy(): Promise<void>;
}
