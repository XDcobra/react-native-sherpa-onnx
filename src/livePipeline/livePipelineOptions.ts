import type { SegmentationPolicy } from '../segment/engine-types';

/**
 * Mandatory segmentation block for live-overload methods.
 *
 * `mode` is intentionally restricted to `'auto'` in the public type surface.
 * Runtime validation still guards dynamic JS callers that can bypass TS checks.
 */
export interface LiveOfflineSegmentationConfig {
  policy: SegmentationPolicy;
  mode?: 'auto';
}

/**
 * Shared base options for all live-overload feature methods.
 */
export interface LiveOfflinePipelineBaseOptions {
  segmentation: LiveOfflineSegmentationConfig;
}
