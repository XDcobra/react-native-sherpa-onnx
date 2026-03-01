import type {
  TtsStreamHandlers,
  TtsStreamController,
  TtsGenerationOptions,
  TTSModelInfo,
} from './types';

// Re-export streaming event types for consumers who import from streamingTypes
export type {
  TtsStreamChunk,
  TtsStreamEnd,
  TtsStreamError,
  TtsStreamHandlers,
  TtsStreamController,
  TtsGenerationOptions,
  TTSModelInfo,
} from './types';

/**
 * Streaming-only TTS engine returned by createStreamingTTS().
 * Use for incremental generation with chunk callbacks and PCM playback.
 * Call destroy() when done to free native resources.
 */
export interface StreamingTtsEngine {
  readonly instanceId: string;

  /** Generate speech in streaming mode; audio delivered via handlers. */
  generateSpeechStream(
    text: string,
    options: TtsGenerationOptions | undefined,
    handlers: TtsStreamHandlers
  ): Promise<TtsStreamController>;

  /** Cancel the current streaming generation. */
  cancelSpeechStream(): Promise<void>;

  /** Start built-in PCM playback (e.g. for play-while-generating). */
  startPcmPlayer(sampleRate: number, channels: number): Promise<void>;

  /** Write float PCM samples to the player. Use from onChunk. */
  writePcmChunk(samples: number[]): Promise<void>;

  /** Stop and release the PCM player. */
  stopPcmPlayer(): Promise<void>;

  /** Model sample rate and number of speakers. */
  getModelInfo(): Promise<TTSModelInfo>;

  getSampleRate(): Promise<number>;
  getNumSpeakers(): Promise<number>;

  /** Release native TTS resources. Do not use the engine after this. */
  destroy(): Promise<void>;
}
