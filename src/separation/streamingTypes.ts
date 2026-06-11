import type { StreamingPipelineHandle } from '../audiobuffer/streamingPipelineTypes';

/** Returned by live `separate(Live, Live[], options)` overload. */
export interface SeparationPipelineHandle extends StreamingPipelineHandle {
  /** Offline separation engine instance driving this pipeline. */
  readonly instanceId: string;
}
