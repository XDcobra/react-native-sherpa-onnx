import type { SegmentReason } from 'react-native-sherpa-onnx/segment';

/**
 * Stable showcase colors for each {@link SegmentReason} (timeline bars + reason badges).
 * Unknown reasons fall back to {@link SEGMENT_REASON_FALLBACK_COLOR}.
 */
export const SEGMENT_REASON_COLORS: Record<SegmentReason, string> = {
  endpoint: '#5C6BC0',
  punctuation: '#7E57C2',
  length_limit: '#FB8C00',
  vad_boundary: '#00897B',
  energy_silence: '#43A047',
  manual_commit: '#607D8B',
  finalize: '#1565C0',
  policy_checkpoint: '#D81B60',
};

export const SEGMENT_REASON_FALLBACK_COLOR = '#9E9E9E';

/** Readable label on colored badges / thin timeline strips. */
export const SEGMENT_REASON_BADGE_LABEL_COLOR = '#FFFFFF';

export function getColorForSegmentReason(reason: string | undefined): string {
  if (reason != null && reason in SEGMENT_REASON_COLORS) {
    return SEGMENT_REASON_COLORS[reason as SegmentReason];
  }
  return SEGMENT_REASON_FALLBACK_COLOR;
}
