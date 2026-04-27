import type { Segment, SpeechSegment, TextSegment } from './segment';
import type { SegmentLink } from './segment-link';
import { validateSegment, validateSegmentLink } from './segment-validation';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function parseTextSegment(raw: Record<string, unknown>): TextSegment {
  return {
    segmentId: String(raw.segmentId ?? ''),
    domain: 'text',
    startOffset: Number(raw.startOffset ?? 0),
    endOffset: Number(raw.endOffset ?? 0),
    reason: raw.reason as TextSegment['reason'],
    source: raw.source as TextSegment['source'],
    createdAtMs: Number(raw.createdAtMs ?? 0),
    segmentIndex: Number(raw.segmentIndex ?? 0),
    text: String(raw.text ?? ''),
    utf16Length: Number(raw.utf16Length ?? 0),
    ...(Array.isArray(raw.tokens) ? { tokens: raw.tokens.map(String) } : {}),
    ...(Array.isArray(raw.timestamps)
      ? { timestamps: raw.timestamps.map((v) => Number(v)) }
      : {}),
    ...(typeof raw.lang === 'string' ? { lang: raw.lang } : {}),
    ...(isRecord(raw.meta) ? { meta: raw.meta } : {}),
  };
}

function parseSpeechSegment(raw: Record<string, unknown>): SpeechSegment {
  const vadInfoRaw = isRecord(raw.vadInfo) ? raw.vadInfo : undefined;
  return {
    segmentId: String(raw.segmentId ?? ''),
    domain: 'speech',
    startOffset: Number(raw.startOffset ?? 0),
    endOffset: Number(raw.endOffset ?? 0),
    reason: raw.reason as SpeechSegment['reason'],
    source: raw.source as SpeechSegment['source'],
    createdAtMs: Number(raw.createdAtMs ?? 0),
    segmentIndex: Number(raw.segmentIndex ?? 0),
    sourceAudioBufferId: String(raw.sourceAudioBufferId ?? ''),
    sampleRate: Number(raw.sampleRate ?? 0),
    durationMs: Number(raw.durationMs ?? 0),
    ...(typeof raw.confidence === 'number'
      ? { confidence: raw.confidence }
      : {}),
    ...(typeof raw.energy === 'number' ? { energy: raw.energy } : {}),
    ...(vadInfoRaw
      ? {
          vadInfo: {
            ...(typeof vadInfoRaw.engine === 'string'
              ? { engine: vadInfoRaw.engine }
              : {}),
            ...(typeof vadInfoRaw.decision === 'string'
              ? { decision: vadInfoRaw.decision }
              : {}),
            ...(typeof vadInfoRaw.score === 'number'
              ? { score: vadInfoRaw.score }
              : {}),
          },
        }
      : {}),
    ...(isRecord(raw.meta) ? { meta: raw.meta } : {}),
  };
}

export function segmentFromJson(raw: unknown): Segment {
  if (!isRecord(raw)) throw new Error('SEGMENT_INVALID: expected object');
  const domain = raw.domain;
  const parsed =
    domain === 'text' ? parseTextSegment(raw) : parseSpeechSegment(raw);
  validateSegment(parsed);
  return parsed;
}

export function segmentToJson(segment: Segment): Segment {
  validateSegment(segment);
  return segment;
}

export function segmentLinkFromJson(raw: unknown): SegmentLink {
  if (!isRecord(raw)) throw new Error('SEGMENT_LINK_INVALID: expected object');
  const parsed: SegmentLink = {
    linkId: String(raw.linkId ?? ''),
    textSegmentId: String(raw.textSegmentId ?? ''),
    speechSegmentId: String(raw.speechSegmentId ?? ''),
    linkType: raw.linkType as SegmentLink['linkType'],
    ...(typeof raw.confidence === 'number'
      ? { confidence: raw.confidence }
      : {}),
    ...(isRecord(raw.meta) ? { meta: raw.meta } : {}),
  };
  validateSegmentLink(parsed);
  return parsed;
}

export function segmentLinkToJson(link: SegmentLink): SegmentLink {
  validateSegmentLink(link);
  return link;
}
