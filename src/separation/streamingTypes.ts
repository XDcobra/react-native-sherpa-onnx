import type { StreamingPipelineHandle } from '../audiobuffer/streamingPipelineTypes';

/** Returned by future live `separate(Live, Live[], options)` overload. */
export interface SeparationPipelineHandle extends StreamingPipelineHandle {
  /** Offline separation engine instance driving this pipeline. */
  readonly instanceId: string;
}
