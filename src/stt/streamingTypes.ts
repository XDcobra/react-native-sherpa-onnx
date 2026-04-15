import type { ModelPathConfig } from '../types';
import type { LiveAudioBufferIdSource } from '../audiobuffer/types';
import type { LiveTextBufferIdSource } from '../textbuffer/types';
import type { StreamingPipelineHandle } from '../audiobuffer/streamingPipelineTypes';

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
  /**
   * Feature extraction dither. **Android:** applied natively. **iOS:** ignored (C/CXX API has no
   * `dither` on `FeatureConfig`); library default applies.
   */
  dither?: number;
  /** Blank penalty. */
  blankPenalty?: number;
  /** Enable debug logging. Default: false. */
  debug?: boolean;
}

/** Options for starting a native STT pipeline worker. */
export interface SttPipelineOptions {
  /** Number of audio samples drained per worker loop. Default: 3200. */
  chunkSize?: number;
}

/** Pipeline handle returned by LiveSttEngine.transcribe(). */
export interface SttPipelineHandle extends StreamingPipelineHandle {
  /** STT engine instance id driving this pipeline. */
  readonly instanceId: string;
}

/** Streaming STT engine in pipeline mode (live audio -> live text). */
export interface LiveSttEngine {
  readonly instanceId: string;

  /**
   * Start native pipeline transcription:
   * - drains audio from a live audio buffer
   * - runs online recognizer decode loop
   * - writes partials + committed segments to a live text buffer
   */
  transcribe(
    audioIn: LiveAudioBufferIdSource,
    textOut: LiveTextBufferIdSource,
    options?: SttPipelineOptions
  ): Promise<SttPipelineHandle>;

  /** Release native recognizer and stop any active pipeline. */
  destroy(): Promise<void>;
}
