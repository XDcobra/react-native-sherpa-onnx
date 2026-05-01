import { TurboModuleRegistry } from 'react-native';
import type { Spec } from '../NativeSherpaOnnx';
import {
  appendLiveTextSegment,
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
  clearAttachedSegmentationEngineByEngineId,
  deleteOfflineTextSegments,
  getOfflineTextSegments,
  hasOfflineTextSegments,
  getLiveAudioSegmentation,
  getLiveTextSegmentation,
  getSpeechSegmentAnnotation,
  normalizeSegmentationMode,
  registerLiveAudioSegmentation,
  registerLiveTextSegmentation,
  registerAttachedSegmentationEngine,
  setAssociatedAudioSegmentBuffer,
  setOfflineTextSegments,
} from './runtime-state';
import type {
  SegmentationConfig,
  SegmentationEngineInfo,
  SegmentationEngineRef,
  SegmentationPolicy,
} from './engine-types';
import { detectVadModel } from '../vad/engine';
import { toSegmentReason, toSegmentSource } from './utils';

const getNative = (): Spec =>
  TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');

const MAX_SENTENCE_BOUNDARY_DELIMITER_ENTRIES = 64;
const MAX_SENTENCE_BOUNDARY_DELIMITER_STRLEN = 32;

function normalizeSentenceBoundaryCharsForNative(
  raw: unknown
): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new Error(
      'SEGMENT_INVALID_ARGUMENT: sentenceBoundaryChars must be an array of strings when provided'
    );
  }
  if (raw.length > MAX_SENTENCE_BOUNDARY_DELIMITER_ENTRIES) {
    throw new Error(
      `SEGMENT_INVALID_ARGUMENT: sentenceBoundaryChars must have at most ${MAX_SENTENCE_BOUNDARY_DELIMITER_ENTRIES} entries`
    );
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw new Error(
        'SEGMENT_INVALID_ARGUMENT: sentenceBoundaryChars must contain only strings'
      );
    }
    if (item.length === 0) {
      continue;
    }
    if (item.length > MAX_SENTENCE_BOUNDARY_DELIMITER_STRLEN) {
      throw new Error(
        `SEGMENT_INVALID_ARGUMENT: each sentenceBoundaryChars entry must be at most ${MAX_SENTENCE_BOUNDARY_DELIMITER_STRLEN} characters`
      );
    }
    out.push(item);
  }
  return out.length > 0 ? out : undefined;
}

function normalizeSegmentationPolicyFromNative(
  raw: unknown
): SegmentationPolicy {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('SEGMENT_INTERNAL: invalid native segmentation policy');
  }
  const p = { ...(raw as Record<string, unknown>) } as Record<string, unknown>;
  const mp = p.modelPath;
  if (mp != null) {
    if (typeof mp === 'string' && mp.trim().length > 0) {
      p.modelPath = { kind: 'fs', path: mp.trim() };
    } else if (typeof mp === 'object' && !Array.isArray(mp)) {
      const m = mp as Record<string, unknown>;
      if (m.kind === 'fs' && typeof m.path === 'string') {
        p.modelPath = { kind: 'fs', path: m.path };
      } else if (m.type === 'file' && typeof m.path === 'string') {
        p.modelPath = { kind: 'fs', path: m.path };
      } else {
        delete p.modelPath;
      }
    }
  }
  delete p.modelType;
  return p as unknown as SegmentationPolicy;
}

async function segmentationPolicyForNative(
  policy: SegmentationPolicy
): Promise<Object> {
  const { modelPath: fileSource, sentenceBoundaryChars, ...rest } = policy;
  const out: Record<string, unknown> = { ...rest };
  const normalized = normalizeSentenceBoundaryCharsForNative(
    sentenceBoundaryChars
  );
  if (normalized !== undefined) {
    out.sentenceBoundaryChars = normalized;
  }
  if (policy.evaluator === 'speech_vad_model') {
    if (fileSource == null) {
      throw new Error(
        'SEGMENT_INVALID_ARGUMENT: speech_vad_model requires policy.modelPath'
      );
    }
    const detect = await detectVadModel(fileSource, { modelType: 'auto' });
    const onnxPath = detect.paths?.model?.trim();
    if (
      !detect.success ||
      onnxPath == null ||
      onnxPath.length === 0 ||
      detect.modelType == null ||
      detect.modelType === ''
    ) {
      const detail =
        typeof detect.error === 'string' && detect.error.trim().length > 0
          ? detect.error.trim()
          : 'VAD model detection failed';
      throw Object.assign(
        new Error(
          `POLICY_MODEL_UNAVAILABLE: speech_vad_model requires a detectable VAD bundle (${detail})`
        ),
        { code: 'POLICY_MODEL_UNAVAILABLE' }
      );
    }
    out.modelPath = onnxPath;
    out.modelType = detect.modelType;
  } else if (fileSource != null) {
    throw new Error(
      'SEGMENT_INVALID_ARGUMENT: policy.modelPath is only valid for speech_vad_model'
    );
  }
  return out as Object;
}

const offlineAudioSegmentBufferByParentBufferId = new Map<string, string>();
const pendingOfflineAudioSegmentBufferByParentBufferId = new Map<
  string,
  Promise<string>
>();

const DEFAULT_TEXT_POLICY: SegmentationPolicy = {
  evaluator: 'text_synthetic_auto',
  sentenceBoundary: true,
  maxLengthChars: 500,
};

const DEFAULT_SPEECH_POLICY: SegmentationPolicy = {
  evaluator: 'speech_energy_silence',
  silenceThresholdMs: 500,
  energyThresholdDb: -40,
  minSegmentMs: 1000,
  maxSegmentMs: 30000,
  hangoverMs: 300,
};

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

function toEngineInfo(raw: {
  engineId: string;
  attachedBufferId: string;
  domain: 'text' | 'speech';
  policy: object;
  state: 'active' | 'detached';
  totalSegmentsCommitted: number;
  lastSegmentId?: string;
  segmentBufferId?: string;
}): SegmentationEngineInfo {
  return {
    engineId: raw.engineId,
    attachedBufferId: raw.attachedBufferId,
    domain: raw.domain,
    policy: normalizeSegmentationPolicyFromNative(raw.policy),
    state: raw.state,
    totalSegmentsCommitted: raw.totalSegmentsCommitted,
    ...(typeof raw.lastSegmentId === 'string' && raw.lastSegmentId.length > 0
      ? { lastSegmentId: raw.lastSegmentId }
      : {}),
    ...(typeof raw.segmentBufferId === 'string' &&
    raw.segmentBufferId.length > 0
      ? { segmentBufferId: raw.segmentBufferId }
      : {}),
  };
}

function resolveDefaultPolicy(domain: 'text' | 'speech'): SegmentationPolicy {
  return domain === 'text' ? DEFAULT_TEXT_POLICY : DEFAULT_SPEECH_POLICY;
}

function normalizeReadWindow(
  startIndex: number,
  maxCount: number
): { startIndex: number; maxCount: number } {
  if (!Number.isFinite(startIndex) || !Number.isInteger(startIndex)) {
    throw new Error(
      `SEGMENT_INVALID_ARGUMENT: startIndex must be a finite integer; received ${String(
        startIndex
      )}`
    );
  }
  if (!Number.isFinite(maxCount) || !Number.isInteger(maxCount)) {
    throw new Error(
      `SEGMENT_INVALID_ARGUMENT: maxCount must be a finite integer; received ${String(
        maxCount
      )}`
    );
  }
  if (startIndex < 0) {
    throw new Error(
      `SEGMENT_INVALID_ARGUMENT: startIndex must be >= 0; received ${startIndex}`
    );
  }
  if (maxCount < 0) {
    throw new Error(
      `SEGMENT_INVALID_ARGUMENT: maxCount must be >= 0; received ${maxCount}`
    );
  }
  return {
    startIndex: Math.trunc(startIndex),
    maxCount: Math.trunc(maxCount),
  };
}

function assertSegmentIndexInRange(
  startIndex: number,
  totalCount: number
): void {
  if (totalCount > 0 && startIndex >= totalCount) {
    throw new Error(
      `SEGMENT_INDEX_OUT_OF_RANGE: startIndex ${startIndex} is outside segment count ${totalCount}`
    );
  }
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
  throw new Error(`SEGMENT_LINK_INVALID: invalid linkType "${String(raw)}"`);
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
  if (count <= 0 || maxCount === 0) return [];
  assertSegmentIndexInRange(startIndex, count);

  const endExclusive = Math.min(count, startIndex + maxCount);
  // Contract: native/JS producers that commit live text segments must set
  // meta.__segmentReason (and related __segment* keys). Missing reason →
  // toSegmentReason(undefined) → 'manual_commit' (no inference from item.source).
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
        reason: toSegmentReason(reasonRaw),
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
  const info = await getPipelineTextBufferInfo(offlineTextBufferId);
  if (info.kind !== 'offlineTextBuffer') {
    deleteOfflineTextSegments(offlineTextBufferId);
    return [];
  }

  if (maxCount === 0) {
    return [];
  }

  if (!hasOfflineTextSegments(offlineTextBufferId)) {
    throw new Error(
      'SEGMENT_NOT_AVAILABLE: offline text segmentation is not materialized; call segmentOfflineBuffer() first'
    );
  }

  const cached = getOfflineTextSegments(offlineTextBufferId) ?? [];
  if (cached.length === 0) {
    return [];
  }

  assertSegmentIndexInRange(startIndex, cached.length);
  return cached.slice(startIndex, startIndex + maxCount);
}

async function ensureOfflineAudioSegmentBuffer(
  offlineAudioBufferId: string
): Promise<string> {
  const existing =
    offlineAudioSegmentBufferByParentBufferId.get(offlineAudioBufferId);
  if (existing) return existing;

  const pending =
    pendingOfflineAudioSegmentBufferByParentBufferId.get(offlineAudioBufferId);
  if (pending) return pending;

  const creating = (async (): Promise<string> => {
    const segmented = await segmentOfflineBuffer(
      offlineAudioBufferId,
      DEFAULT_SPEECH_POLICY
    );
    return segmented.segmentBufferId;
  })();

  pendingOfflineAudioSegmentBufferByParentBufferId.set(
    offlineAudioBufferId,
    creating
  );

  try {
    const segmentBufferId = await creating;
    offlineAudioSegmentBufferByParentBufferId.set(
      offlineAudioBufferId,
      segmentBufferId
    );
    return segmentBufferId;
  } finally {
    pendingOfflineAudioSegmentBufferByParentBufferId.delete(
      offlineAudioBufferId
    );
  }
}

async function readSpeechSegmentsFromSegmentBuffer(
  segmentBufferId: string,
  parentBufferId: string,
  startIndex = 0,
  maxCount = 1024
): Promise<SpeechSegment[]> {
  const totalCount = segmentBufferId.startsWith('seg_live_')
    ? await getLiveSegmentBufferSegmentCount(segmentBufferId)
    : (await getPipelineSegmentBufferInfo(segmentBufferId)).segmentCount;
  if (totalCount <= 0 || maxCount === 0) return [];
  assertSegmentIndexInRange(startIndex, totalCount);

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
      const nativeReason = toSegmentReason(
        (segment as unknown as { reason?: string }).reason
      );
      const nativeSource = toSegmentSource(
        (segment as unknown as { source?: string }).source
      );
      const nativeCreatedAtMsRaw = (
        segment as unknown as { createdAtMs?: number }
      ).createdAtMs;
      const annotation = getSpeechSegmentAnnotation(segment.id);
      return {
        segmentId: segment.id,
        domain: 'speech',
        startOffset: segment.startSample,
        endOffset: segment.endSample,
        reason: annotation?.reason ?? nativeReason,
        source: annotation?.source ?? nativeSource,
        createdAtMs:
          annotation?.createdAtMs ??
          (typeof nativeCreatedAtMsRaw === 'number'
            ? Math.trunc(nativeCreatedAtMsRaw)
            : Date.now()),
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

export async function attachSegmentationEngine(
  buffer: PipelineTextBufferIdSource | PipelineAudioBufferIdSource,
  config: SegmentationConfig
): Promise<SegmentationEngineRef> {
  const rawId = resolveSourceBufferId(buffer as SegmentBufferSource);

  let domain: 'text' | 'speech';
  let bufferId: string;
  if (isLiveTextBufferId(rawId)) {
    domain = 'text';
    bufferId = resolvePipelineTextBufferId(
      buffer as PipelineTextBufferIdSource
    );
    registerLiveTextSegmentation(bufferId, 'auto');
  } else {
    bufferId = resolvePipelineAudioBufferId(
      buffer as PipelineAudioBufferIdSource
    );
    if (!isLiveAudioBufferId(bufferId)) {
      throw new Error(
        'SEGMENT_INVALID_ARGUMENT: attachSegmentationEngine() requires a live text or live audio buffer'
      );
    }
    domain = 'speech';
    registerLiveAudioSegmentation(bufferId, 'auto');
  }

  const policy = config.policy ?? resolveDefaultPolicy(domain);
  const nativePolicy = await segmentationPolicyForNative(policy);
  const attached = await getNative().attachSegmentationEngine(
    bufferId,
    domain,
    nativePolicy
  );

  registerAttachedSegmentationEngine(bufferId, attached.engineId, domain, {
    associatedSegmentBufferId: attached.segmentBufferId,
  });
  if (domain === 'speech' && attached.segmentBufferId) {
    setAssociatedAudioSegmentBuffer(bufferId, attached.segmentBufferId);
  }

  return { engineId: attached.engineId };
}

export async function detachSegmentationEngine(
  engine: SegmentationEngineRef | string,
  options?: { flushFinal?: boolean }
): Promise<void> {
  const engineId = typeof engine === 'string' ? engine : engine.engineId;
  await getNative().detachSegmentationEngine(engineId, options?.flushFinal);
  clearAttachedSegmentationEngineByEngineId(engineId);
}

export async function getSegmentationEngineInfo(
  engine: SegmentationEngineRef | string
): Promise<SegmentationEngineInfo> {
  const engineId = typeof engine === 'string' ? engine : engine.engineId;
  const info = toEngineInfo(
    await getNative().getSegmentationEngineInfo(engineId)
  );
  registerAttachedSegmentationEngine(
    info.attachedBufferId,
    info.engineId,
    info.domain,
    {
      associatedSegmentBufferId: info.segmentBufferId,
    }
  );
  if (info.domain === 'speech' && info.segmentBufferId) {
    setAssociatedAudioSegmentBuffer(
      info.attachedBufferId,
      info.segmentBufferId
    );
  }
  return info;
}

export async function segmentOfflineBuffer(
  buffer: PipelineTextBufferIdSource | PipelineAudioBufferIdSource,
  policy: SegmentationPolicy
): Promise<SegmentBufferRef> {
  const rawId = resolveSourceBufferId(buffer as SegmentBufferSource);

  if (isOfflineTextBufferId(rawId)) {
    const bufferId = resolvePipelineTextBufferId(
      buffer as PipelineTextBufferIdSource
    );
    const nativePolicy = await segmentationPolicyForNative(policy);
    const out = await getNative().segmentOfflineBuffer(
      bufferId,
      'text',
      nativePolicy
    );

    const createdAtMs = Date.now();
    const nativeSegments = Array.isArray(out.segments) ? out.segments : [];
    const materialized: TextSegment[] = nativeSegments.map((segment, index) => {
      const text = segment.text;
      const startOffset = Math.max(0, Math.trunc(segment.startOffset));
      const endOffset = Math.max(startOffset, Math.trunc(segment.endOffset));
      return {
        segmentId: segment.segmentId,
        domain: 'text',
        startOffset,
        endOffset,
        reason: toSegmentReason(segment.reason),
        source: toSegmentSource(segment.source),
        createdAtMs,
        segmentIndex: index,
        text,
        utf16Length: text.length,
      };
    });
    setOfflineTextSegments(bufferId, materialized);

    return {
      segmentBufferId: bufferId,
      domain: 'text',
      parentBufferId: bufferId,
    };
  }

  const audioBufferId = resolvePipelineAudioBufferId(
    buffer as PipelineAudioBufferIdSource
  );
  if (!isOfflineAudioBufferId(audioBufferId)) {
    throw new Error(
      'SEGMENT_INVALID_ARGUMENT: segmentOfflineBuffer() requires an offline text or offline audio buffer'
    );
  }

  const nativePolicy = await segmentationPolicyForNative(policy);
  const out = await getNative().segmentOfflineBuffer(
    audioBufferId,
    'speech',
    nativePolicy
  );
  if (!isSegmentBufferId(out.bufferId)) {
    throw new Error(
      'SEGMENT_INTERNAL_ERROR: native segmentOfflineBuffer must return a segment buffer id for speech domain'
    );
  }
  offlineAudioSegmentBufferByParentBufferId.set(audioBufferId, out.bufferId);
  return {
    segmentBufferId: out.bufferId,
    domain: 'speech',
    parentBufferId: audioBufferId,
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
  annotateSpeechSegment(
    appendResult.segmentId,
    {
      reason: options.reason ?? 'manual_commit',
      source: options.source ?? 'manual',
      createdAtMs: Date.now(),
      segmentIndex,
    },
    liveAudioBufferId
  );
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
  if (isLiveTextBufferId(rawId) || isOfflineTextBufferId(rawId)) {
    const textId = resolvePipelineTextBufferId(
      buffer as PipelineTextBufferIdSource
    );
    return {
      segmentBufferId: textId,
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
    const associatedOfflineSegmentBufferId =
      await ensureOfflineAudioSegmentBuffer(audioBufferId);
    return {
      segmentBufferId: associatedOfflineSegmentBufferId,
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
  const window = normalizeReadWindow(startIndex, maxCount);
  const segBuffer = await getSegmentBuffer(buffer);
  if (segBuffer.domain === 'text') {
    if (isLiveTextBufferId(segBuffer.parentBufferId)) {
      return readTextSegments(
        segBuffer.parentBufferId,
        window.startIndex,
        window.maxCount
      );
    }
    if (isOfflineTextBufferId(segBuffer.parentBufferId)) {
      return readOfflineTextSegments(
        segBuffer.parentBufferId,
        window.startIndex,
        window.maxCount
      );
    }
    throw new Error(
      'SEGMENT_INVALID_ARGUMENT: unsupported text segment buffer source'
    );
  }

  if (!isSegmentBufferId(segBuffer.segmentBufferId)) {
    throw new Error(
      'SEGMENT_INVALID_ARGUMENT: expected a live/offline segment buffer id for speech domain'
    );
  }

  return readSpeechSegmentsFromSegmentBuffer(
    segBuffer.segmentBufferId,
    segBuffer.parentBufferId,
    window.startIndex,
    window.maxCount
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
      if (!hasOfflineTextSegments(segBuffer.parentBufferId)) {
        throw new Error(
          'SEGMENT_NOT_AVAILABLE: offline text segmentation is not materialized; call segmentOfflineBuffer() first'
        );
      }
      return getOfflineTextSegments(segBuffer.parentBufferId)?.length ?? 0;
    }
    return 0;
  }

  if (!isSegmentBufferId(segBuffer.segmentBufferId)) {
    throw new Error(
      'SEGMENT_INVALID_ARGUMENT: expected a live/offline segment buffer id for speech domain'
    );
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

export type {
  SegmentationConfig,
  SegmentationEngineInfo,
  SegmentationEngineRef,
  SegmentationEvaluator,
  SegmentationPolicy,
} from './engine-types';

export type { SegmentationMode } from './runtime-state';

export type {
  Segment,
  SegmentBase,
  SegmentDomain,
  SegmentReason,
  SegmentSource,
  SpeechSegment,
  SpeechSegmentVadInfo,
  TextSegment,
} from './segment';
export { isSpeechSegment, isTextSegment } from './segment';

export type {
  SegmentLink,
  SegmentLinkMapInfo,
  SegmentLinkMapRef,
  SegmentLinkType,
} from './segment-link';

export type { ValidateSegmentationOptions } from './validation';
export { validateSegmentationConfig } from './validation';

export {
  segmentFromJson,
  segmentLinkFromJson,
  segmentLinkToJson,
  segmentToJson,
} from './segment-serialization';
export { validateSegment, validateSegmentLink } from './segment-validation';
