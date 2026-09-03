import type {
  StreamingPipelineCompletion,
  StreamingPipelineHandle,
  StreamingPipelineStatus,
} from '../audiobuffer/streamingPipelineTypes';

/**
 * Pipeline handle returned by `labelLiveSegments`.
 *
 * Same control surface as {@link StreamingPipelineHandle}, plus the SID engine
 * `instanceId`. Lifecycle is JS-orchestrated in this release (segmentation
 * attach + per-utterance extract/search); a future native worker can back the
 * same shape without changing the public API.
 */
export interface SpeakerIdentificationPipelineHandle
  extends StreamingPipelineHandle {
  readonly instanceId: string;
}

export type { StreamingPipelineCompletion, StreamingPipelineStatus };
