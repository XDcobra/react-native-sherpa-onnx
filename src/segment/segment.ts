/**
 * Phase 1a Segmentation Contract: canonical segment types.
 *
 * Design intent:
 * - Segment = boundary within a single domain (text OR speech)
 * - Immutable after commit
 * - Shared across streaming and offline pipelines
 */

export type SegmentDomain = 'text' | 'speech';

export type SegmentReason =
  | 'endpoint'
  | 'punctuation'
  | 'length_limit'
  | 'vad_boundary'
  | 'energy_silence'
  | 'manual_commit'
  | 'finalize'
  | 'policy_checkpoint';

export type SegmentSource = 'segmentation_engine' | 'manual' | 'external';

export interface SegmentBase {
  segmentId: string;
  domain: SegmentDomain;
  startOffset: number;
  endOffset: number;
  reason: SegmentReason;
  source: SegmentSource;
  createdAtMs: number;
  segmentIndex: number;
}

export interface TextSegment extends SegmentBase {
  domain: 'text';
  text: string;
  utf16Length: number;
  tokens?: string[];
  timestamps?: number[];
  lang?: string;
  meta?: Record<string, unknown>;
}

export interface SpeechSegmentVadInfo {
  engine?: string;
  decision?: string;
  score?: number;
}

export interface SpeechSegment extends SegmentBase {
  domain: 'speech';
  sourceAudioBufferId: string;
  sampleRate: number;
  durationMs: number;
  confidence?: number;
  energy?: number;
  vadInfo?: SpeechSegmentVadInfo;
  meta?: Record<string, unknown>;
}

export type Segment = TextSegment | SpeechSegment;

export function isTextSegment(seg: Segment): seg is TextSegment {
  return seg.domain === 'text';
}

export function isSpeechSegment(seg: Segment): seg is SpeechSegment {
  return seg.domain === 'speech';
}
