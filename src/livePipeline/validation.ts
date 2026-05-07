import type { SegmentationPolicy } from '../segment/engine-types';
import { validateSegmentationConfig } from '../segment/validation';
import type { LiveOfflineSegmentationConfig } from './livePipelineOptions';

export const LIVE_OFFLINE_SEGMENTATION_REQUIRED =
  'LIVE_OFFLINE_SEGMENTATION_REQUIRED' as const;

export type LiveOfflineErrorCode = typeof LIVE_OFFLINE_SEGMENTATION_REQUIRED;

export class LiveOfflinePipelineError extends Error {
  readonly code: LiveOfflineErrorCode;
  readonly feature: string;

  constructor(feature: string, message: string, options?: ErrorOptions) {
    super(`${LIVE_OFFLINE_SEGMENTATION_REQUIRED}: ${message}`, options);
    this.name = 'LiveOfflinePipelineError';
    this.code = LIVE_OFFLINE_SEGMENTATION_REQUIRED;
    this.feature = feature;
  }
}

export interface ValidateLiveOfflinePipelineOptions {
  featureName: string;
  domain: 'text' | 'speech';
  supportedEvaluators?: string[];
  segmentation: unknown;
}

function stripKnownPrefix(input: string): string {
  const prefix = `${LIVE_OFFLINE_SEGMENTATION_REQUIRED}: `;
  return input.startsWith(prefix) ? input.slice(prefix.length) : input;
}

function missingPolicyMessage(featureName: string): string {
  return (
    `${featureName} requires segmentation.policy (mode must not be "off"). ` +
    'Provide a valid policy (e.g. speech_energy_silence, text_synthetic_auto, or continuous_frames for enhancement).'
  );
}

/**
 * Validates mandatory segmentation for live-overload calls.
 *
 * Returns only `{ policy }` because this path is always mode='auto'.
 * Throws `LiveOfflinePipelineError` for all contract violations.
 */
export function validateLiveOfflinePipelineOptions(
  args: ValidateLiveOfflinePipelineOptions
): { policy: SegmentationPolicy } {
  const { featureName, domain, supportedEvaluators } = args;
  const seg = args.segmentation as
    | Partial<LiveOfflineSegmentationConfig>
    | undefined;

  if (!seg) {
    throw new LiveOfflinePipelineError(
      featureName,
      missingPolicyMessage(featureName)
    );
  }

  if (seg.mode != null && seg.mode !== 'auto') {
    throw new LiveOfflinePipelineError(
      featureName,
      `${featureName} live overload requires segmentation.mode === 'auto' (received "${seg.mode}"). ` +
        'For non-segmented batch processing use the offline overload (Off, Off).'
    );
  }

  if (!seg.policy) {
    throw new LiveOfflinePipelineError(
      featureName,
      missingPolicyMessage(featureName)
    );
  }

  try {
    validateSegmentationConfig({
      mode: 'auto',
      policy: seg.policy,
      featureName,
      domain,
      supportsManual: false,
      supportedEvaluators,
      errorPrefix: LIVE_OFFLINE_SEGMENTATION_REQUIRED,
    });
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : `policy validation failed: ${String(err)}`;
    throw new LiveOfflinePipelineError(
      featureName,
      stripKnownPrefix(message),
      err instanceof Error ? { cause: err } : undefined
    );
  }

  return { policy: seg.policy };
}
