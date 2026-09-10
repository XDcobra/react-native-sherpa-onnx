import type {
  StreamingPipelineCompletion,
  StreamingPipelineHandle,
  StreamingPipelineStatus,
} from '../audiobuffer/streamingPipelineTypes';

/**
 * Pipeline handle returned by live `tag(liveAudio, liveText, options)`.
 *
 * Same control surface as {@link StreamingPipelineHandle}, plus the audio
 * tagging engine `instanceId`.
 */
export interface AudioTaggingPipelineHandle extends StreamingPipelineHandle {
  readonly instanceId: string;
}

export type { StreamingPipelineCompletion, StreamingPipelineStatus };
