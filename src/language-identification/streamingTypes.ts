import type {
  StreamingPipelineCompletion,
  StreamingPipelineHandle,
  StreamingPipelineStatus,
} from '../audiobuffer/streamingPipelineTypes';

/**
 * Pipeline handle returned by live `identify(liveAudio, liveText, options)`.
 *
 * Same control surface as {@link StreamingPipelineHandle}, plus the SLID engine
 * `instanceId`.
 */
export interface LanguageIdentificationPipelineHandle
  extends StreamingPipelineHandle {
  readonly instanceId: string;
}

export type { StreamingPipelineCompletion, StreamingPipelineStatus };
