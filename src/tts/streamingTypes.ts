import type { LiveTextBufferIdSource } from '../textbuffer/types';
import type { LiveAudioBufferIdSource } from '../audiobuffer/types';
import type { StreamingPipelineHandle } from '../audiobuffer/streamingPipelineTypes';
import type { TtsVoiceClone, TTSModelInfo } from './types';

// Re-export types that are still needed
export type { TTSModelInfo } from './types';

/** TTS-specific pipeline handle. Extends generic StreamingPipelineHandle. */
export interface TtsPipelineHandle extends StreamingPipelineHandle {
  /** The TTS engine instance driving this pipeline. */
  readonly instanceId: string;
}

/** Options for starting a TTS pipeline (passed to synthesize()). */
export interface TtsPipelineOptions {
  /** Speaker ID. Default: 0. Overridable per-segment via meta.sid. */
  sid?: number;
  /** Speed multiplier. Default: 1.0. Overridable per-segment via meta.speed. */
  speed?: number;
  /**
   * Voice cloning configuration. Set once for the entire pipeline.
   * Applies to all segments (cloning reference audio is loaded once on pipeline start).
   * Uses OfflineAudioBuffer reference (same as batch synthesis).
   */
  voiceClone?: TtsVoiceClone;
}

/**
 * Streaming TTS engine returned by `createStreamingTTS()`.
 * Pipeline-only — no legacy event-based streaming methods.
 *
 * **`tts`** is the value returned by `createStreamingTTS()`.
 * **`pipeline`** is the handle returned by `tts.synthesize(...)`.
 */
export interface StreamingTtsEngine {
  readonly instanceId: string;

  /**
   * Start a native streaming TTS pipeline.
   *
   * A dedicated background worker thread drains committed text segments from
   * `textIn` via cursor, resolves per-segment `sid`/`speed` from
   * `segment.meta` (falling back to `options` defaults), synthesizes each
   * segment via the TTS engine, and writes PCM samples to `audioOut`.
   *
   * - `textIn` must be a live text buffer in `recording` state.
   * - `audioOut` must be a live audio buffer in `recording` state.
   * - `audioOut.sampleRate` must equal the TTS model's output sample rate (strict).
   * - Only one pipeline per TTS instance at a time.
   *
   * Returns a handle to control and inspect the running pipeline.
   */
  synthesize(
    textIn: LiveTextBufferIdSource,
    audioOut: LiveAudioBufferIdSource,
    options?: TtsPipelineOptions
  ): Promise<TtsPipelineHandle>;

  /** Model sample rate and number of speakers. */
  getModelInfo(): Promise<TTSModelInfo>;
  getSampleRate(): Promise<number>;
  getNumSpeakers(): Promise<number>;

  /**
   * Destroy the engine. Stops any running pipeline first.
   * Do not use the engine after this.
   */
  destroy(): Promise<void>;
}
