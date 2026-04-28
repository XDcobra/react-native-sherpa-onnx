import type {
  Segment,
  SegmentDomain,
  SegmentReason,
  SegmentSource,
  SpeechSegment,
  TextSegment,
} from './segment';
import type { SegmentLink, SegmentLinkType } from './segment-link';

const SEGMENT_DOMAINS = new Set<SegmentDomain>(['text', 'speech']);
const SEGMENT_REASONS = new Set<SegmentReason>([
  'endpoint',
  'punctuation',
  'length_limit',
  'vad_boundary',
  'energy_silence',
  'manual_commit',
  'finalize',
  'policy_checkpoint',
]);
const SEGMENT_SOURCES = new Set<SegmentSource>([
  'segmentation_engine',
  'manual',
  'external',
]);
const SEGMENT_LINK_TYPES = new Set<SegmentLinkType>([
  'alignment',
  'proportional',
  'vad_assisted',
  'sequential',
  'tts_produced',
  'stt_produced',
  'user_defined',
]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function assertBaseSegmentFields(segment: Segment): void {
  if (!segment.segmentId?.trim())
    throw new Error('SEGMENT_INVALID: segmentId must be non-empty');
  if (!SEGMENT_DOMAINS.has(segment.domain))
    throw new Error('SEGMENT_INVALID: domain is invalid');
  if (!Number.isInteger(segment.startOffset) || segment.startOffset < 0) {
    throw new Error(
      'SEGMENT_INVALID: startOffset must be a non-negative integer'
    );
  }
  if (
    !Number.isInteger(segment.endOffset) ||
    segment.endOffset <= segment.startOffset
  ) {
    throw new Error(
      'SEGMENT_INVALID: endOffset must be an integer > startOffset'
    );
  }
  if (!SEGMENT_REASONS.has(segment.reason))
    throw new Error('SEGMENT_INVALID: reason is invalid');
  if (!SEGMENT_SOURCES.has(segment.source))
    throw new Error('SEGMENT_INVALID: source is invalid');
  if (!Number.isInteger(segment.createdAtMs) || segment.createdAtMs < 0) {
    throw new Error(
      'SEGMENT_INVALID: createdAtMs must be a non-negative integer'
    );
  }
  if (!Number.isInteger(segment.segmentIndex) || segment.segmentIndex < 0) {
    throw new Error(
      'SEGMENT_INVALID: segmentIndex must be a non-negative integer'
    );
  }
}

function assertTextSegmentFields(segment: TextSegment): void {
  if (!segment.text.length)
    throw new Error('SEGMENT_INVALID: text must be non-empty');
  if (
    !Number.isInteger(segment.utf16Length) ||
    segment.utf16Length !== segment.text.length
  ) {
    throw new Error('SEGMENT_INVALID: utf16Length must equal text.length');
  }
  if (
    segment.tokens != null &&
    !segment.tokens.every((x) => typeof x === 'string')
  ) {
    throw new Error('SEGMENT_INVALID: tokens must be string[]');
  }
  if (
    segment.timestamps != null &&
    !segment.timestamps.every((x) => isFiniteNumber(x))
  ) {
    throw new Error('SEGMENT_INVALID: timestamps must be number[]');
  }
  if (segment.lang != null && typeof segment.lang !== 'string') {
    throw new Error('SEGMENT_INVALID: lang must be a string');
  }
  if (segment.meta != null && !isObjectRecord(segment.meta)) {
    throw new Error('SEGMENT_INVALID: meta must be an object');
  }
}

function assertSpeechSegmentFields(segment: SpeechSegment): void {
  if (!segment.sourceAudioBufferId?.trim()) {
    throw new Error('SEGMENT_INVALID: sourceAudioBufferId must be non-empty');
  }
  if (!Number.isInteger(segment.sampleRate) || segment.sampleRate <= 0) {
    throw new Error('SEGMENT_INVALID: sampleRate must be a positive integer');
  }
  if (!isFiniteNumber(segment.durationMs) || segment.durationMs <= 0) {
    throw new Error('SEGMENT_INVALID: durationMs must be > 0');
  }
  if (segment.confidence != null && !isFiniteNumber(segment.confidence)) {
    throw new Error('SEGMENT_INVALID: confidence must be a finite number');
  }
  if (segment.energy != null && !isFiniteNumber(segment.energy)) {
    throw new Error('SEGMENT_INVALID: energy must be a finite number');
  }
  if (segment.vadInfo != null) {
    if (!isObjectRecord(segment.vadInfo)) {
      throw new Error('SEGMENT_INVALID: vadInfo must be an object');
    }
    if (
      segment.vadInfo.score != null &&
      !isFiniteNumber(segment.vadInfo.score)
    ) {
      throw new Error('SEGMENT_INVALID: vadInfo.score must be a finite number');
    }
  }
  if (segment.meta != null && !isObjectRecord(segment.meta)) {
    throw new Error('SEGMENT_INVALID: meta must be an object');
  }
}

export function validateSegment(segment: Segment): void {
  assertBaseSegmentFields(segment);
  if (segment.domain === 'text') {
    assertTextSegmentFields(segment);
    return;
  }
  assertSpeechSegmentFields(segment);
}

export function validateSegmentLink(link: SegmentLink): void {
  if (!link.linkId?.trim())
    throw new Error('SEGMENT_LINK_INVALID: linkId must be non-empty');
  if (!link.textSegmentId?.trim())
    throw new Error('SEGMENT_LINK_INVALID: textSegmentId must be non-empty');
  if (!link.speechSegmentId?.trim())
    throw new Error('SEGMENT_LINK_INVALID: speechSegmentId must be non-empty');
  if (!SEGMENT_LINK_TYPES.has(link.linkType)) {
    throw new Error('SEGMENT_LINK_INVALID: linkType is invalid');
  }
  if (link.confidence != null && !isFiniteNumber(link.confidence)) {
    throw new Error('SEGMENT_LINK_INVALID: confidence must be a finite number');
  }
  if (link.meta != null && !isObjectRecord(link.meta)) {
    throw new Error('SEGMENT_LINK_INVALID: meta must be an object');
  }
}
