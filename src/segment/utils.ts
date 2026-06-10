import type { SegmentReason, SegmentSource } from './segment';

/**
 * Maps a raw value to a valid SegmentSource.
 * Falls back to the provided 'fallback' if the value is unknown.
 */
export function toSegmentSource(
  raw: unknown,
  fallback: SegmentSource = 'manual'
): SegmentSource {
  return raw === 'segmentation_engine' || raw === 'manual' || raw === 'external'
    ? raw
    : fallback;
}

/**
 * Maps a raw value to a valid SegmentReason.
 * Falls back to the provided 'fallback' if the value is unknown.
 */
export function toSegmentReason(
  raw: unknown,
  fallback: SegmentReason = 'manual_commit'
): SegmentReason {
  return raw === 'endpoint' ||
    raw === 'punctuation' ||
    raw === 'length_limit' ||
    raw === 'vad_boundary' ||
    raw === 'energy_silence' ||
    raw === 'manual_commit' ||
    raw === 'finalize' ||
    raw === 'policy_checkpoint'
    ? raw
    : fallback;
}

/**
 * Infers a likely SegmentReason from the producer source tag.
 * Used primarily for events where the native layer might only provide 'source'.
 */
export function inferSegmentReasonFromSource(source: string): SegmentReason {
  if (source === 'stt_stream') return 'endpoint';
  if (source === 'segmentation_engine') return 'endpoint';
  if (source === 'punctuation') return 'punctuation';
  return 'manual_commit';
}
