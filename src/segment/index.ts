import { TurboModuleRegistry } from 'react-native';
import type { Spec } from '../NativeSherpaOnnx';
import {
  appendLiveTextSegment,
  getOfflineTextBufferTextSlice,
  getLiveTextBufferPartialSlice,
  getLiveTextBufferSegmentCount,
  getLiveTextBufferSegments,
  getPipelineTextBufferInfo,
  resolvePipelineTextBufferId,
} from '../textbuffer';
import {
  getPipelineAudioBufferInfo,
  resolvePipelineAudioBufferId,
} from '../audiobuffer';
import {
  appendLiveSegment,
  createLiveSegmentBuffer,
  getLiveSegmentBufferSegmentCount,
  getLiveSegmentBufferSegments,
  getOfflineSegmentBufferSegments,
  getPipelineSegmentBufferInfo,
} from '../segmentbuffer';
import type { PipelineAudioBufferIdSource } from '../audiobuffer/types';
import type { PipelineTextBufferIdSource } from '../textbuffer/types';
import type { PipelineSegmentBufferIdSource } from '../segmentbuffer/types';
import type {
  Segment,
  SegmentReason,
  SegmentSource,
  SpeechSegment,
  TextSegment,
} from './segment';
import type {
  SegmentLink,
  SegmentLinkMapInfo,
  SegmentLinkMapRef,
  SegmentLinkType,
} from './segment-link';
import {
  advanceAudioCommitStart,
  annotateSpeechSegment,
  getLiveAudioSegmentation,
  getLiveTextSegmentation,
  getSpeechSegmentAnnotation,
  normalizeSegmentationMode,
  setAssociatedAudioSegmentBuffer,
} from './runtime-state';

const getNative = (): Spec =>
  TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');

const TEXT_SEGMENT_PROXY_PREFIX = 'seg_text_proxy_';
const AUDIO_SEGMENT_PROXY_PREFIX = 'seg_audio_proxy_';

export interface SegmentBufferRef {
  segmentBufferId: string;
  domain: 'text' | 'speech';
  parentBufferId: string;
}

export interface CommitSegmentOptions {
  reason?: SegmentReason;
  source?: SegmentSource;
  tokens?: string[];
  timestamps?: number[];
  lang?: string;
  meta?: Record<string, unknown>;
}

type SegmentBufferSource =
  | SegmentBufferRef
  | PipelineTextBufferIdSource
  | PipelineAudioBufferIdSource
  | PipelineSegmentBufferIdSource;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function isSegmentBufferRef(source: unknown): source is SegmentBufferRef {
  return (
    isRecord(source) &&
    typeof source.segmentBufferId === 'string' &&
    typeof source.domain === 'string' &&
    typeof source.parentBufferId === 'string'
  );
}

function isLiveTextBufferId(id: string): boolean {
  return id.startsWith('txt_live_');
}

function isOfflineTextBufferId(id: string): boolean {
  return id.startsWith('txt_off_');
}

function isLiveAudioBufferId(id: string): boolean {
  return id.startsWith('live_');
}

function isOfflineAudioBufferId(id: string): boolean {
  return id.startsWith('off_');
}

function isSegmentBufferId(id: string): boolean {
  return id.startsWith('seg_live_') || id.startsWith('seg_off_');
}

function isTextProxySegmentBufferId(id: string): boolean {
  return id.startsWith(TEXT_SEGMENT_PROXY_PREFIX);
}

function isAudioProxySegmentBufferId(id: string): boolean {
  return id.startsWith(AUDIO_SEGMENT_PROXY_PREFIX);
}

function toSegmentSource(raw: unknown): SegmentSource {
  return raw === 'segmentation_engine' || raw === 'manual' || raw === 'external'
    ? raw
    : 'manual';
}

function toSegmentReason(raw: unknown): SegmentReason {
  return raw === 'endpoint' ||
    raw === 'punctuation' ||
    raw === 'length_limit' ||
    raw === 'vad_boundary' ||
    raw === 'energy_silence' ||
    raw === 'manual_commit' ||
    raw === 'finalize' ||
    raw === 'policy_checkpoint'
    ? raw
    : 'manual_commit';
}

function inferReasonFromLegacySource(source: string): SegmentReason {
  if (source === 'stt_stream') return 'endpoint';
  return 'manual_commit';
}

function normalizeLinkType(raw: unknown): SegmentLinkType {
  if (
    raw === 'alignment' ||
    raw === 'proportional' ||
    raw === 'vad_assisted' ||
    raw === 'sequential' ||
    raw === 'tts_produced' ||
    raw === 'stt_produced' ||
    raw === 'user_defined'
  ) {
    return raw;
  }
  throw new Error(`SEGMENT_LINK_INVALID: invalid linkType \"${String(raw)}\"`);
}

function sanitizeLink(raw: {
  linkId: string;
  textSegmentId: string;
  speechSegmentId: string;
  linkType: string;
  confidence?: number;
  meta?: unknown;
}): SegmentLink {
  return {
    linkId: raw.linkId,
    textSegmentId: raw.textSegmentId,
    speechSegmentId: raw.speechSegmentId,
    linkType: normalizeLinkType(raw.linkType),
    ...(typeof raw.confidence === 'number'
      ? { confidence: raw.confidence }
      : {}),
    ...(isRecord(raw.meta) ? { meta: raw.meta } : {}),
  };
}

function resolveSourceBufferId(source: SegmentBufferSource): string {
  if (isSegmentBufferRef(source)) return source.segmentBufferId;
  if (typeof source === 'string') return source;
  if (isRecord(source) && typeof source.bufferId === 'string') {
    return source.bufferId;
  }
  return String(source);
}

async function ensureAudioSegmentBuffer(
  liveAudioBufferId: string
): Promise<string> {
  const state = getLiveAudioSegmentation(liveAudioBufferId);
  const mode = normalizeSegmentationMode(state?.mode, 'off');
  if (mode === 'off') {
    throw new Error(
      'SEGMENT_NOT_AVAILABLE: segmentation is disabled for this live audio buffer'
    );
  }
  if (state?.associatedSegmentBufferId) {
    return state.associatedSegmentBufferId;
  }
  const seg = await createLiveSegmentBuffer({
    sourceAudioBufferId: liveAudioBufferId,
  });
  setAssociatedAudioSegmentBuffer(liveAudioBufferId, seg.bufferId);
  return seg.bufferId;
}

function toPublicTextSegmentMeta(
  meta: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const out = { ...meta };
  delete out.__segmentReason;
  delete out.__segmentSource;
  delete out.__segmentCreatedAtMs;
  delete out.__segmentId;
  delete out.__segmentLang;
  return Object.keys(out).length > 0 ? out : undefined;
}

async function readTextSegments(
  liveTextBufferId: string,
  startIndex = 0,
  maxCount = 1024
): Promise<TextSegment[]> {
  const count = await getLiveTextBufferSegmentCount(liveTextBufferId);
  if (count <= 0 || startIndex >= count || maxCount <= 0) return [];

  const endExclusive = Math.min(count, startIndex + maxCount);
  const raw = await getLiveTextBufferSegments(
    liveTextBufferId,
    0,
    endExclusive,
    {
      includeMeta: true,
      includeTokens: true,
      includeTimestamps: true,
    }
  );

  const segments: TextSegment[] = [];
  let offset = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i]!;
    const utf16Length = item.text.length;
    if (i >= startIndex) {
      const rawMeta = isRecord(item.meta)
        ? (item.meta as Record<string, unknown>)
        : undefined;
      const createdAtMsRaw = rawMeta?.__segmentCreatedAtMs;
      const reasonRaw = rawMeta?.__segmentReason;
      const sourceRaw = rawMeta?.__segmentSource;
      const segmentIdRaw = rawMeta?.__segmentId;
      const langRaw = rawMeta?.__segmentLang;

      segments.push({
        segmentId:
          typeof segmentIdRaw === 'string' && segmentIdRaw.length > 0
            ? segmentIdRaw
            : `txtseg_${liveTextBufferId}_${item.segmentIndex}`,
        domain: 'text',
        startOffset: offset,
        endOffset: offset + utf16Length,
        reason: toSegmentReason(
          reasonRaw ?? inferReasonFromLegacySource(item.source)
        ),
        source: toSegmentSource(
          sourceRaw ??
            (item.source === 'append' ? 'manual' : 'segmentation_engine')
        ),
        createdAtMs:
          typeof createdAtMsRaw === 'number' && Number.isFinite(createdAtMsRaw)
            ? Math.trunc(createdAtMsRaw)
            : Date.now(),
        segmentIndex: item.segmentIndex,
        text: item.text,
        utf16Length,
        ...(Array.isArray(item.tokens) ? { tokens: item.tokens } : {}),
        ...(Array.isArray(item.timestamps)
          ? { timestamps: item.timestamps }
          : {}),
        ...(typeof langRaw === 'string' && langRaw.length > 0
          ? { lang: langRaw }
          : {}),
        ...(toPublicTextSegmentMeta(rawMeta)
          ? { meta: toPublicTextSegmentMeta(rawMeta) }
          : {}),
      });
    }
    offset += utf16Length;
  }

  return segments;
}

async function readOfflineTextSegments(
  offlineTextBufferId: string,
  startIndex = 0,
  maxCount = 1024
): Promise<TextSegment[]> {
  if (startIndex > 0 || maxCount <= 0) return [];

  const info = await getPipelineTextBufferInfo(offlineTextBufferId);
  if (info.kind !== 'offlineTextBuffer' || info.utf16Length <= 0) return [];

  const text = await getOfflineTextBufferTextSlice(
    offlineTextBufferId,
    0,
    Math.max(1, info.utf16Length)
  );
  if (text.length === 0) return [];

  return [
    {
      segmentId: `txtseg_${offlineTextBufferId}_0`,
      domain: 'text',
      startOffset: 0,
      endOffset: text.length,
      reason: 'finalize',
      source: 'external',
      createdAtMs: Date.now(),
      segmentIndex: 0,
      text,
      utf16Length: text.length,
    },
  ];
}

async function readOfflineAudioSegments(
  offlineAudioBufferId: string,
  startIndex = 0,
  maxCount = 1024
): Promise<SpeechSegment[]> {
  if (startIndex > 0 || maxCount <= 0) return [];

  const info = await getPipelineAudioBufferInfo(offlineAudioBufferId);
  if (info.kind !== 'offlinePcmBuffer' || info.numSamples <= 0) return [];

  return [
    {
      segmentId: `audseg_${offlineAudioBufferId}_0`,
      domain: 'speech',
      startOffset: 0,
      endOffset: info.numSamples,
      reason: 'finalize',
      source: 'external',
      createdAtMs: Date.now(),
      segmentIndex: 0,
      sourceAudioBufferId: offlineAudioBufferId,
      sampleRate: info.sampleRate,
      durationMs: info.durationMs,
    },
  ];
}

async function readSpeechSegmentsFromSegmentBuffer(
  segmentBufferId: string,
  parentBufferId: string,
  startIndex = 0,
  maxCount = 1024
): Promise<SpeechSegment[]> {
  const raw = segmentBufferId.startsWith('seg_live_')
    ? await getLiveSegmentBufferSegments(segmentBufferId, startIndex, maxCount)
    : await getOfflineSegmentBufferSegments(
        segmentBufferId,
        startIndex,
        maxCount
      );

  return raw
    .filter((segment) => segment.kind === 'speech')
    .map((segment, idx) => {
      const annotation = getSpeechSegmentAnnotation(segment.id);
      return {
        segmentId: segment.id,
        domain: 'speech',
        startOffset: segment.startSample,
        endOffset: segment.endSample,
        reason: annotation?.reason ?? 'manual_commit',
        source: annotation?.source ?? 'manual',
        createdAtMs: annotation?.createdAtMs ?? Date.now(),
        segmentIndex: annotation?.segmentIndex ?? startIndex + idx,
        sourceAudioBufferId: segment.sourceAudioBufferId || parentBufferId,
        sampleRate: segment.sampleRate,
        durationMs: segment.durationMs,
        ...(typeof segment.confidence === 'number'
          ? { confidence: segment.confidence }
          : {}),
        ...(segment.payload != null
          ? {
              meta: {
                payload: segment.payload as unknown as Record<string, unknown>,
              },
            }
          : {}),
      };
    });
}

async function resolveSpeechSegmentBufferRef(
  source: SegmentBufferSource
): Promise<SegmentBufferRef> {
  if (isSegmentBufferRef(source)) {
    if (source.domain === 'speech') return source;
    throw new Error('SEGMENT_INVALID_ARGUMENT: expected speech segment buffer');
  }

  const id = resolveSourceBufferId(source);
  if (isSegmentBufferId(id)) {
    const info = await getPipelineSegmentBufferInfo(id);
    const parent =
      'sourceAudioBufferId' in info &&
      typeof info.sourceAudioBufferId === 'string'
        ? info.sourceAudioBufferId
        : id;
    return {
      segmentBufferId: id,
      domain: 'speech',
      parentBufferId: parent,
    };
  }

  const liveAudioId = resolvePipelineAudioBufferId(
    source as PipelineAudioBufferIdSource
  );
  if (!isLiveAudioBufferId(liveAudioId)) {
    throw new Error(
      'SEGMENT_NOT_AVAILABLE: offline audio buffers do not expose live segment commits'
    );
  }
  const associatedSegmentBufferId = await ensureAudioSegmentBuffer(liveAudioId);
  return {
    segmentBufferId: associatedSegmentBufferId,
    domain: 'speech',
    parentBufferId: liveAudioId,
  };
}

export async function setPartial(
  buffer: PipelineTextBufferIdSource,
  text: string
): Promise<void> {
  const liveTextBufferId = resolvePipelineTextBufferId(buffer);
  if (!isLiveTextBufferId(liveTextBufferId)) {
    throw new Error(
      'SEGMENT_INVALID_ARGUMENT: setPartial() requires a live text buffer'
    );
  }
  await getNative().setLiveTextBufferPartial(liveTextBufferId, text);
}

export async function appendPartial(
  buffer: PipelineTextBufferIdSource,
  text: string
): Promise<void> {
  const liveTextBufferId = resolvePipelineTextBufferId(buffer);
  if (!isLiveTextBufferId(liveTextBufferId)) {
    throw new Error(
      'SEGMENT_INVALID_ARGUMENT: appendPartial() requires a live text buffer'
    );
  }
  await getNative().appendLiveTextBufferPartial(liveTextBufferId, text);
}

export async function commitSegment(
  buffer: PipelineTextBufferIdSource | PipelineAudioBufferIdSource,
  options: CommitSegmentOptions = {}
): Promise<Segment> {
  const rawId = resolveSourceBufferId(buffer as SegmentBufferSource);

  if (isLiveTextBufferId(rawId)) {
    const state = getLiveTextSegmentation(rawId);
    const mode = normalizeSegmentationMode(state?.mode, 'manual');
    if (mode === 'off') {
      throw new Error(
        'SEGMENT_NOT_AVAILABLE: segmentation is disabled for this live text buffer'
      );
    }

    const text = await getLiveTextBufferPartialSlice(rawId, 0, 2_000_000_000);
    if (text.length === 0) {
      throw new Error(
        'SEGMENT_COMMIT_FAILED: no partial text available to commit'
      );
    }

    const createdAtMs = Date.now();
    const metaWithInternal: Record<string, unknown> = {
      ...(options.meta ?? {}),
      __segmentReason: options.reason ?? 'manual_commit',
      __segmentSource: options.source ?? 'manual',
      __segmentCreatedAtMs: createdAtMs,
      ...(options.lang ? { __segmentLang: options.lang } : {}),
    };

    await appendLiveTextSegment(
      rawId,
      text,
      options.tokens,
      options.timestamps,
      metaWithInternal
    );
    await setPartial(rawId, '');

    const total = await getLiveTextBufferSegmentCount(rawId);
    const segments = await readTextSegments(rawId, total - 1, 1);
    if (segments.length === 0) {
      throw new Error(
        'SEGMENT_COMMIT_FAILED: failed to materialize committed text segment'
      );
    }
    return segments[0]!;
  }

  const liveAudioBufferId = resolvePipelineAudioBufferId(
    buffer as PipelineAudioBufferIdSource
  );
  if (!isLiveAudioBufferId(liveAudioBufferId)) {
    throw new Error(
      'SEGMENT_INVALID_ARGUMENT: commitSegment() requires a live text or live audio buffer'
    );
  }

  const state = getLiveAudioSegmentation(liveAudioBufferId);
  const mode = normalizeSegmentationMode(state?.mode, 'off');
  if (mode === 'off') {
    throw new Error(
      'SEGMENT_NOT_AVAILABLE: segmentation is disabled for this live audio buffer'
    );
  }

  const segRef = await resolveSpeechSegmentBufferRef(liveAudioBufferId);
  const audioInfo = await getPipelineAudioBufferInfo(liveAudioBufferId);
  if (audioInfo.kind !== 'livePcmBuffer') {
    throw new Error('SEGMENT_INVALID_ARGUMENT: expected a live audio buffer');
  }

  const startSample = state?.nextCommitStartSample ?? 0;
  const endSample = Math.trunc(audioInfo.totalSamplesWritten);
  if (endSample <= startSample) {
    throw new Error(
      'SEGMENT_COMMIT_FAILED: no uncommitted audio frames available'
    );
  }

  const sampleRate = audioInfo.sampleRate;
  const durationMs = ((endSample - startSample) / sampleRate) * 1000;
  const appendResult = await appendLiveSegment(segRef.segmentBufferId, {
    kind: 'speech',
    sourceAudioBufferId: liveAudioBufferId,
    startSample,
    endSample,
    sampleRate,
    durationMs,
  });

  const total = await getLiveSegmentBufferSegmentCount(segRef.segmentBufferId);
  const segmentIndex = Math.max(0, total - 1);
  annotateSpeechSegment(appendResult.segmentId, {
    reason: options.reason ?? 'manual_commit',
    source: options.source ?? 'manual',
    createdAtMs: Date.now(),
    segmentIndex,
  });
  advanceAudioCommitStart(liveAudioBufferId, endSample);

  const segments = await readSpeechSegmentsFromSegmentBuffer(
    segRef.segmentBufferId,
    liveAudioBufferId,
    segmentIndex,
    1
  );
  if (segments.length === 0) {
    throw new Error(
      'SEGMENT_COMMIT_FAILED: failed to materialize committed speech segment'
    );
  }
  return segments[0]!;
}

export async function getSegmentBuffer(
  buffer: SegmentBufferSource
): Promise<SegmentBufferRef> {
  if (isSegmentBufferRef(buffer)) return buffer;

  const rawId = resolveSourceBufferId(buffer);
  if (isTextProxySegmentBufferId(rawId)) {
    return {
      segmentBufferId: rawId,
      domain: 'text',
      parentBufferId: rawId.slice(TEXT_SEGMENT_PROXY_PREFIX.length),
    };
  }

  if (isAudioProxySegmentBufferId(rawId)) {
    return {
      segmentBufferId: rawId,
      domain: 'speech',
      parentBufferId: rawId.slice(AUDIO_SEGMENT_PROXY_PREFIX.length),
    };
  }

  if (isLiveTextBufferId(rawId) || isOfflineTextBufferId(rawId)) {
    const textId = resolvePipelineTextBufferId(
      buffer as PipelineTextBufferIdSource
    );
    return {
      segmentBufferId: `${TEXT_SEGMENT_PROXY_PREFIX}${textId}`,
      domain: 'text',
      parentBufferId: textId,
    };
  }

  if (isSegmentBufferId(rawId)) {
    const info = await getPipelineSegmentBufferInfo(rawId);
    const parent =
      'sourceAudioBufferId' in info &&
      typeof info.sourceAudioBufferId === 'string'
        ? info.sourceAudioBufferId
        : rawId;
    return {
      segmentBufferId: rawId,
      domain: 'speech',
      parentBufferId: parent,
    };
  }

  const audioBufferId = resolvePipelineAudioBufferId(
    buffer as PipelineAudioBufferIdSource
  );
  if (isOfflineAudioBufferId(audioBufferId)) {
    return {
      segmentBufferId: `${AUDIO_SEGMENT_PROXY_PREFIX}${audioBufferId}`,
      domain: 'speech',
      parentBufferId: audioBufferId,
    };
  }
  return resolveSpeechSegmentBufferRef(audioBufferId);
}

export async function getSegments(
  buffer: SegmentBufferSource,
  startIndex = 0,
  maxCount = 1024
): Promise<Segment[]> {
  const segBuffer = await getSegmentBuffer(buffer);
  if (segBuffer.domain === 'text') {
    if (isLiveTextBufferId(segBuffer.parentBufferId)) {
      return readTextSegments(segBuffer.parentBufferId, startIndex, maxCount);
    }
    if (isOfflineTextBufferId(segBuffer.parentBufferId)) {
      return readOfflineTextSegments(
        segBuffer.parentBufferId,
        startIndex,
        maxCount
      );
    }
    return [];
  }

  if (isAudioProxySegmentBufferId(segBuffer.segmentBufferId)) {
    return readOfflineAudioSegments(
      segBuffer.parentBufferId,
      startIndex,
      maxCount
    );
  }

  return readSpeechSegmentsFromSegmentBuffer(
    segBuffer.segmentBufferId,
    segBuffer.parentBufferId,
    startIndex,
    maxCount
  );
}

export async function getSegmentCount(
  buffer: SegmentBufferSource
): Promise<number> {
  const segBuffer = await getSegmentBuffer(buffer);
  if (segBuffer.domain === 'text') {
    if (isLiveTextBufferId(segBuffer.parentBufferId)) {
      return getLiveTextBufferSegmentCount(segBuffer.parentBufferId);
    }
    if (isOfflineTextBufferId(segBuffer.parentBufferId)) {
      const info = await getPipelineTextBufferInfo(segBuffer.parentBufferId);
      return info.kind === 'offlineTextBuffer' && info.utf16Length > 0 ? 1 : 0;
    }
    return 0;
  }

  if (isAudioProxySegmentBufferId(segBuffer.segmentBufferId)) {
    const info = await getPipelineAudioBufferInfo(segBuffer.parentBufferId);
    return info.kind === 'offlinePcmBuffer' && info.numSamples > 0 ? 1 : 0;
  }

  if (segBuffer.segmentBufferId.startsWith('seg_live_')) {
    return getLiveSegmentBufferSegmentCount(segBuffer.segmentBufferId);
  }
  const info = await getPipelineSegmentBufferInfo(segBuffer.segmentBufferId);
  return info.segmentCount;
}

export async function createSegmentLinkMap(options?: {
  textBufferId?: string;
  audioBufferId?: string;
}): Promise<SegmentLinkMapRef> {
  const out = await getNative().createSegmentLinkMap(options);
  return { linkMapId: out.linkMapId };
}

export async function addSegmentLink(
  linkMap: SegmentLinkMapRef | string,
  link: {
    textSegmentId: string;
    speechSegmentId: string;
    linkType: SegmentLinkType;
    confidence?: number;
    meta?: Record<string, unknown>;
  }
): Promise<SegmentLink> {
  const linkMapId = typeof linkMap === 'string' ? linkMap : linkMap.linkMapId;
  const out = await getNative().addSegmentLink(linkMapId, {
    textSegmentId: link.textSegmentId,
    speechSegmentId: link.speechSegmentId,
    linkType: link.linkType,
    confidence: link.confidence,
    meta: link.meta,
  });
  return sanitizeLink(out);
}

export async function addSegmentLinks(
  linkMap: SegmentLinkMapRef | string,
  links: Array<{
    textSegmentId: string;
    speechSegmentId: string;
    linkType: SegmentLinkType;
    confidence?: number;
    meta?: Record<string, unknown>;
  }>
): Promise<SegmentLink[]> {
  const linkMapId = typeof linkMap === 'string' ? linkMap : linkMap.linkMapId;
  const out = await getNative().addSegmentLinks(
    linkMapId,
    links.map((it) => ({
      textSegmentId: it.textSegmentId,
      speechSegmentId: it.speechSegmentId,
      linkType: it.linkType,
      ...(typeof it.confidence === 'number'
        ? { confidence: it.confidence }
        : {}),
      ...(it.meta != null ? { meta: it.meta } : {}),
    }))
  );
  return out.links.map(sanitizeLink);
}

export async function removeSegmentLink(
  linkMap: SegmentLinkMapRef | string,
  linkId: string
): Promise<void> {
  const linkMapId = typeof linkMap === 'string' ? linkMap : linkMap.linkMapId;
  await getNative().removeSegmentLink(linkMapId, linkId);
}

export async function getSpeechSegmentsForText(
  linkMap: SegmentLinkMapRef | string,
  textSegmentId: string
): Promise<SegmentLink[]> {
  const linkMapId = typeof linkMap === 'string' ? linkMap : linkMap.linkMapId;
  const out = await getNative().getSpeechSegmentsForText(
    linkMapId,
    textSegmentId
  );
  return out.links.map(sanitizeLink);
}

export async function getTextSegmentsForSpeech(
  linkMap: SegmentLinkMapRef | string,
  speechSegmentId: string
): Promise<SegmentLink[]> {
  const linkMapId = typeof linkMap === 'string' ? linkMap : linkMap.linkMapId;
  const out = await getNative().getTextSegmentsForSpeech(
    linkMapId,
    speechSegmentId
  );
  return out.links.map(sanitizeLink);
}

export async function getAllSegmentLinks(
  linkMap: SegmentLinkMapRef | string,
  startIndex = 0,
  maxCount = 1024
): Promise<SegmentLink[]> {
  const linkMapId = typeof linkMap === 'string' ? linkMap : linkMap.linkMapId;
  const out = await getNative().getAllSegmentLinks(
    linkMapId,
    startIndex,
    maxCount
  );
  return out.links.map(sanitizeLink);
}

export async function getSegmentLinkCount(
  linkMap: SegmentLinkMapRef | string
): Promise<number> {
  const linkMapId = typeof linkMap === 'string' ? linkMap : linkMap.linkMapId;
  return getNative().getSegmentLinkCount(linkMapId);
}

export async function getSegmentLinkMapInfo(
  linkMap: SegmentLinkMapRef | string
): Promise<SegmentLinkMapInfo> {
  const linkMapId = typeof linkMap === 'string' ? linkMap : linkMap.linkMapId;
  const out = await getNative().getSegmentLinkMapInfo(linkMapId);
  return {
    linkMapId: out.linkMapId,
    linkCount: out.linkCount,
    ...(typeof out.textBufferId === 'string' && out.textBufferId.length > 0
      ? { textBufferId: out.textBufferId }
      : {}),
    ...(typeof out.audioBufferId === 'string' && out.audioBufferId.length > 0
      ? { audioBufferId: out.audioBufferId }
      : {}),
  };
}

export async function releaseSegmentLinkMap(
  linkMap: SegmentLinkMapRef | string
): Promise<void> {
  const linkMapId = typeof linkMap === 'string' ? linkMap : linkMap.linkMapId;
  await getNative().releaseSegmentLinkMap(linkMapId);
}
