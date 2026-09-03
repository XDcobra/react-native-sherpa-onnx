import type {
  StreamingPipelineCompletion,
  StreamingPipelineHandle,
  StreamingPipelineStatus,
} from '../audiobuffer/streamingPipelineTypes';

/**
 * Pipeline handle returned by `labelLiveSegments`.
 *
 * Same control surface as {@link StreamingPipelineHandle}, plus the SID engine
 * `instanceId`.
 */
export interface SpeakerIdentificationPipelineHandle
  extends StreamingPipelineHandle {
  readonly instanceId: string;
}

export type { StreamingPipelineCompletion, StreamingPipelineStatus };
