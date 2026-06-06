import SherpaOnnx from '../../NativeSherpaOnnx';
import {
  getPipelineAudioBufferInfo,
  resolvePipelineAudioBufferId,
} from '../../audiobuffer';
import type {
  OfflineAudioBufferInfo,
  OfflineAudioBufferIdSource,
} from '../../audiobuffer/types';
import {
  appendLiveSegment,
  createLiveSegmentBuffer,
  finalizeLiveSegmentBuffer,
  getOfflineSegmentBufferSegments,
  getPipelineSegmentBufferInfo,
  populateOfflineSegmentBufferIfEmpty,
  releasePipelineSegmentBuffer,
  resolveOfflineSegmentBufferId,
} from '../../segmentbuffer';
import type {
  OfflineSegmentBufferInfo,
  OfflineSegmentBufferIdSource,
  SpeechSegmentMeta,
} from '../../segmentbuffer/types';
import {
  getOfflineTextBufferTextSlice,
  getPipelineTextBufferInfo,
  resolveOfflineTextBufferId,
} from '../../textbuffer';
import type {
  OfflineTextBufferIdSource,
  OfflineTextBufferInfo,
} from '../../textbuffer/types';
import type { FileSource } from '../../fileio/types';
import { resolveFileSourceForModelInit } from '../../detect/resolveModelInput';
import { runLinker } from '../linker/linker';
import type {
  AlignmentErrorCode,
  AlignmentWarning,
  AlignmentWarningCode,
  AlignTextToAudioWriteResult,
  OrchestrationProgress,
} from '../types';
import { createAlignmentProgressSession } from '../progress';
import type { LinkerWarning } from '../linker/types';
import type {
  AsrMediatedAggregatedAlignmentSegment,
  AsrMediatedAnchor,
  AsrMediatedAnchorJob,
} from './types';

type AsrMediatedRuntimeError = Error & { code: AlignmentErrorCode };

function createAsrMediatedError(
  code: AlignmentErrorCode,
  message: string,
  cause?: unknown
): AsrMediatedRuntimeError {
  const error = new Error(`${code}: ${message}`) as AsrMediatedRuntimeError;
  error.code = code;
  if (cause instanceof Error) {
    (error as Error & { cause?: unknown }).cause = cause;
  }
  return error;
}

function asOfflineTextBufferInfo(
  info: unknown,
  fieldName: string
): OfflineTextBufferInfo {
  if (
    typeof info === 'object' &&
    info != null &&
    (info as { kind?: unknown }).kind === 'offlineTextBuffer'
  ) {
    return info as OfflineTextBufferInfo;
  }
  throw createAsrMediatedError(
    'ALIGNMENT_OPTIONS_INVALID',
    `${fieldName} must resolve to an offline text buffer.`
  );
}

function asOfflineAudioBufferInfo(info: unknown): OfflineAudioBufferInfo {
  if (
    typeof info === 'object' &&
    info != null &&
    (info as { kind?: unknown }).kind === 'offlinePcmBuffer'
  ) {
    return info as OfflineAudioBufferInfo;
  }
  throw createAsrMediatedError(
    'ALIGNMENT_OPTIONS_INVALID',
    'audioIn must resolve to an offline audio buffer.'
  );
}

function asOfflineSegmentBufferInfo(
  info: unknown,
  fieldName: string
): OfflineSegmentBufferInfo {
  if (
    typeof info === 'object' &&
    info != null &&
    (info as { kind?: unknown }).kind === 'offlineSegmentBuffer'
  ) {
    return info as OfflineSegmentBufferInfo;
  }
  throw createAsrMediatedError(
    'ALIGNMENT_OPTIONS_INVALID',
    `${fieldName} must resolve to an offline segment buffer.`
  );
}

function toAlignmentWarnings(
  linkerWarnings?: LinkerWarning[]
): AlignmentWarning[] {
  if (!Array.isArray(linkerWarnings) || linkerWarnings.length === 0) {
    return [];
  }

  const hasPartialCoverage = linkerWarnings.some(
    (warning) => warning.code === 'PARTIAL_COVERAGE'
  );
  const hasLowConfidenceUnit = linkerWarnings.some(
    (warning) => warning.code === 'LOW_CONFIDENCE_UNIT'
  );

  const warnings: AlignmentWarning[] = [];
  if (hasPartialCoverage) {
    warnings.push({
      code: 'ALIGNMENT_PARTIAL_COVERAGE',
      message:
        'Linker reported partial reference coverage; only covered ranges were aligned.',
    });
  }
  if (hasLowConfidenceUnit) {
    warnings.push({
      code: 'ALIGNMENT_LOW_CONFIDENCE_UNIT_PRESENT',
      message:
        'One or more linker mapping units have low confidence; review alignment quality.',
    });
  }

  return warnings;
}

function toWarningCode(
  warnings: AlignmentWarning[]
): AlignmentWarningCode | undefined {
  return warnings[0]?.code;
}

function normalizeGranularity(
  granularity?: 'sentence' | 'word'
): 'sentence' | 'word' {
  return granularity === 'word' ? 'word' : 'sentence';
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function toSpeechAnchors(segments: unknown[]): AsrMediatedAnchor[] {
  return segments
    .filter(
      (segment): segment is SpeechSegmentMeta =>
        typeof segment === 'object' &&
        segment != null &&
        (segment as { kind?: unknown }).kind === 'speech'
    )
    .map((segment) => ({
      id: segment.id,
      startSample: segment.startSample,
      endSample: segment.endSample,
      sampleRate: segment.sampleRate,
    }))
    .sort((a, b) => a.startSample - b.startSample || a.endSample - b.endSample);
}

function buildAnchorJobs(
  referenceText: string,
  anchors: AsrMediatedAnchor[],
  units: AsrMediatedAnchorJob['mappingUnits']
): AsrMediatedAnchorJob[] {
  const anchorsById = new Map(anchors.map((anchor) => [anchor.id, anchor]));
  const grouped = new Map<string, typeof units>();

  for (const unit of units) {
    if (!anchorsById.has(unit.anchorSegmentId)) {
      continue;
    }
    const current = grouped.get(unit.anchorSegmentId);
    if (current == null) {
      grouped.set(unit.anchorSegmentId, [unit]);
      continue;
    }
    current.push(unit);
  }

  const jobs: AsrMediatedAnchorJob[] = [];
  for (const [anchorSegmentId, groupedUnits] of grouped.entries()) {
    const anchor = anchorsById.get(anchorSegmentId);
    if (!anchor) {
      continue;
    }

    groupedUnits.sort(
      (a, b) =>
        a.refRange.startCharIndex - b.refRange.startCharIndex ||
        a.refRange.endCharIndex - b.refRange.endCharIndex
    );

    const parts: string[] = [];
    for (const unit of groupedUnits) {
      const start = Math.max(0, Math.trunc(unit.refRange.startCharIndex));
      const end = Math.max(start, Math.trunc(unit.refRange.endCharIndex));
      const raw = referenceText.slice(start, end);
      const normalized = normalizeWhitespace(raw);
      if (normalized.length > 0) {
        parts.push(normalized);
      }
    }

    const mergedText = normalizeWhitespace(parts.join(' '));
    if (mergedText.length === 0) {
      continue;
    }

    jobs.push({
      anchor,
      referenceText: mergedText,
      mappingUnits: groupedUnits,
    });
  }

  jobs.sort(
    (a, b) =>
      a.anchor.startSample - b.anchor.startSample ||
      a.anchor.endSample - b.anchor.endSample
  );
  return jobs;
}

function assertAnchorRangeWithinAudio(
  anchor: AsrMediatedAnchor,
  audioInfo: OfflineAudioBufferInfo
): void {
  if (
    anchor.startSample < 0 ||
    anchor.endSample <= anchor.startSample ||
    anchor.endSample > audioInfo.numSamples
  ) {
    throw createAsrMediatedError(
      'ALIGNMENT_ANCHOR_OUT_OF_RANGE',
      `Anchor ${anchor.id} exceeds audio bounds (${anchor.startSample}-${anchor.endSample} over 0-${audioInfo.numSamples}).`
    );
  }
}

interface AsrMediatedNativeSubtitle {
  text: string;
  start: number;
  end: number;
}

function parseAsrMediatedNativeSubtitles(
  raw: unknown
): AsrMediatedNativeSubtitle[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item) => {
      if (typeof item !== 'object' || item == null) {
        return null;
      }

      const text =
        typeof (item as { text?: unknown }).text === 'string'
          ? ((item as { text: string }).text ?? '').trim()
          : '';
      const start = Number((item as { start?: unknown }).start);
      const end = Number((item as { end?: unknown }).end);

      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return null;
      }

      const safeStart = Math.max(0, start);
      const safeEnd = Math.max(safeStart, end);

      return {
        text,
        start: safeStart,
        end: safeEnd,
      };
    })
    .filter((item): item is AsrMediatedNativeSubtitle => item != null);
}

function toAggregatedSegments(
  anchor: AsrMediatedAnchor,
  sourceAudioBufferId: string,
  granularity: 'sentence' | 'word',
  nativeSubtitles: AsrMediatedNativeSubtitle[]
): AsrMediatedAggregatedAlignmentSegment[] {
  return nativeSubtitles.map((subtitle) => {
    const localStart = Math.max(
      0,
      Math.trunc(subtitle.start * anchor.sampleRate)
    );
    const localEnd = Math.max(
      localStart,
      Math.trunc(subtitle.end * anchor.sampleRate)
    );

    const globalStart = anchor.startSample + localStart;
    const globalEnd = anchor.startSample + localEnd;
    const startSample = Math.min(globalStart, anchor.endSample);
    const endSample = Math.min(
      Math.max(startSample, globalEnd),
      anchor.endSample
    );
    const durationMs =
      anchor.sampleRate > 0
        ? ((endSample - startSample) / anchor.sampleRate) * 1000
        : 0;

    return {
      sourceAudioBufferId,
      startSample,
      endSample,
      sampleRate: anchor.sampleRate,
      durationMs,
      payload: {
        text: subtitle.text.length > 0 ? subtitle.text : '[alignment]',
        timingMode: 'accurate',
        granularity,
      },
    };
  });
}

function mapNativeAsrMediatedError(error: unknown): AsrMediatedRuntimeError {
  const errorObj =
    typeof error === 'object' && error != null
      ? (error as { code?: unknown; message?: unknown })
      : undefined;

  const codeFromObject =
    typeof errorObj?.code === 'string' ? errorObj.code.trim() : '';
  const messageFromObject =
    typeof errorObj?.message === 'string' ? errorObj.message.trim() : '';
  const messageFromError =
    error instanceof Error && typeof error.message === 'string'
      ? error.message.trim()
      : messageFromObject;

  const codeFromMessage = (() => {
    const idx = messageFromError.indexOf(':');
    if (idx <= 0) {
      return '';
    }
    return messageFromError.slice(0, idx).trim();
  })();

  const normalizedCode =
    codeFromObject.length > 0 ? codeFromObject : codeFromMessage;

  if (normalizedCode === 'OFFLINE_OOM') {
    return createAsrMediatedError(
      'OFFLINE_OOM',
      messageFromError || 'OFFLINE_OOM: Native alignment ran out of memory.',
      error
    );
  }

  if (
    normalizedCode === 'ALIGNMENT_MODEL_LOAD_FAILED' ||
    normalizedCode === 'ALIGNMENT_ANCHOR_OUT_OF_RANGE' ||
    normalizedCode === 'ALIGNMENT_NATIVE_ACCURATE_FAILED'
  ) {
    return createAsrMediatedError(
      normalizedCode,
      messageFromError ||
        `${normalizedCode}: Native accurate alignment failed.`,
      error
    );
  }

  return createAsrMediatedError(
    'ALIGNMENT_NATIVE_UNKNOWN',
    messageFromError ||
      'ALIGNMENT_NATIVE_UNKNOWN: Native accurate alignment failed with an unknown error.',
    error
  );
}

interface RunAccurateAsrMediatedInput {
  textIn: OfflineTextBufferIdSource;
  audioIn: OfflineAudioBufferIdSource;
  segmentOut: OfflineSegmentBufferIdSource;
  anchorSegmentBuffer: OfflineSegmentBufferIdSource;
  hypothesisTextBuffer: OfflineTextBufferIdSource;
  modelSource: FileSource;
  granularity?: 'sentence' | 'word';
  language?: string;
  onProgress?: (progress: OrchestrationProgress) => void;
}

export async function runAccurateAsrMediated(
  input: RunAccurateAsrMediatedInput
): Promise<AlignTextToAudioWriteResult> {
  const progressSession = createAlignmentProgressSession(input.onProgress);

  const textInBufferId = resolveOfflineTextBufferId(input.textIn);
  const audioInBufferId = resolvePipelineAudioBufferId(input.audioIn);
  const segmentOutBufferId = resolveOfflineSegmentBufferId(input.segmentOut);
  const anchorSegmentBufferId = resolveOfflineSegmentBufferId(
    input.anchorSegmentBuffer
  );
  const hypothesisTextBufferId = resolveOfflineTextBufferId(
    input.hypothesisTextBuffer
  );

  const textInfo = asOfflineTextBufferInfo(
    await getPipelineTextBufferInfo(textInBufferId),
    'textIn'
  );
  const [
    audioInfoRaw,
    anchorInfoRaw,
    segmentOutInfoRaw,
    referenceTextRaw,
    resolvedModelPath,
  ] = await Promise.all([
    getPipelineAudioBufferInfo(audioInBufferId),
    getPipelineSegmentBufferInfo(anchorSegmentBufferId),
    getPipelineSegmentBufferInfo(segmentOutBufferId),
    getOfflineTextBufferTextSlice(textInBufferId, 0, textInfo.utf16Length ?? 0),
    (async () => {
      const dir = (
        await resolveFileSourceForModelInit(input.modelSource)
      ).trim();
      if (!dir) {
        throw createAsrMediatedError(
          'ALIGNMENT_MODEL_LOAD_FAILED',
          'resolveFileSourceForModelInit returned empty for alignment modelSource.'
        );
      }
      const det = await SherpaOnnx.detectAlignmentModel(dir, 'auto');
      const onnx =
        typeof det.paths?.model === 'string' ? det.paths.model.trim() : '';
      if (!det.success || !onnx) {
        const msg =
          typeof det.error === 'string' && det.error.trim().length > 0
            ? det.error.trim()
            : 'Alignment model detection failed: no ONNX path.';
        throw createAsrMediatedError('ALIGNMENT_MODEL_LOAD_FAILED', msg);
      }
      return onnx;
    })(),
  ]);

  const audioInfo = asOfflineAudioBufferInfo(audioInfoRaw);
  const anchorInfo = asOfflineSegmentBufferInfo(
    anchorInfoRaw,
    'anchorSegmentBuffer'
  );
  const segmentOutInfo = asOfflineSegmentBufferInfo(
    segmentOutInfoRaw,
    'segmentOut'
  );
  if ((segmentOutInfo.segmentCount ?? 0) > 0) {
    throw createAsrMediatedError(
      'ALIGNMENT_OPTIONS_INVALID',
      'segmentOut must be an empty offline segment buffer for asrMediated output materialization.'
    );
  }
  const granularity = normalizeGranularity(input.granularity);

  const linkerResult = await runLinker({
    audioIn: audioInBufferId,
    anchors: anchorSegmentBufferId,
    referenceText: textInBufferId,
    hypothesisTextBuffer: hypothesisTextBufferId,
    granularity: granularity === 'word' ? 'word' : 'token',
    ...(typeof input.language === 'string' && input.language.trim().length > 0
      ? { language: input.language }
      : {}),
  });

  if (linkerResult.mappingUnits.length === 0) {
    throw createAsrMediatedError(
      'ALIGNMENT_LINKER_NO_MAPPING',
      'Linker returned no usable mapping units for asrMediated.'
    );
  }

  const anchorsRaw = await getOfflineSegmentBufferSegments(
    anchorSegmentBufferId,
    0,
    anchorInfo.segmentCount ?? 0
  );
  const anchors = toSpeechAnchors(anchorsRaw);
  if (anchors.length === 0) {
    throw createAsrMediatedError(
      'ALIGNMENT_LINKER_INPUT_INVALID',
      'Anchor segment buffer must contain at least one speech segment.'
    );
  }

  const jobs = buildAnchorJobs(
    referenceTextRaw,
    anchors,
    linkerResult.mappingUnits
  );
  if (jobs.length === 0) {
    throw createAsrMediatedError(
      'ALIGNMENT_LINKER_NO_MAPPING',
      'No anchor jobs could be materialized from linker units.'
    );
  }

  const aggregatedSegments: AsrMediatedAggregatedAlignmentSegment[] = [];

  for (const [j, job] of jobs.entries()) {
    assertAnchorRangeWithinAudio(job.anchor, audioInfo);

    const frameCount = job.anchor.endSample - job.anchor.startSample;
    if (frameCount <= 0) {
      continue;
    }

    const currentSegmentDurationMs =
      job.anchor.sampleRate > 0
        ? (frameCount / job.anchor.sampleRate) * 1000
        : 0;

    progressSession.emitStep(j, jobs.length, currentSegmentDurationMs);

    const nativeResultRaw = await (async () => {
      try {
        return SherpaOnnx.alignAccurateFromPcm(
          resolvedModelPath,
          job.referenceText,
          {
            audioBufferId: audioInBufferId,
            startSample: job.anchor.startSample,
            sampleCount: frameCount,
          },
          audioInfo.sampleRate,
          granularity,
          typeof input.language === 'string' ? input.language : undefined
        );
      } catch (error) {
        throw mapNativeAsrMediatedError(error);
      }
    })();

    const nativeSubtitles = parseAsrMediatedNativeSubtitles(
      (nativeResultRaw as { subtitles?: unknown }).subtitles
    );
    if (nativeSubtitles.length === 0) {
      continue;
    }

    aggregatedSegments.push(
      ...toAggregatedSegments(
        job.anchor,
        audioInBufferId,
        granularity,
        nativeSubtitles
      )
    );
  }

  if (aggregatedSegments.length === 0) {
    throw createAsrMediatedError(
      'ALIGNMENT_LINKER_NO_MAPPING',
      'asrMediated produced no aligned segments after per-anchor accurate runs.'
    );
  }

  aggregatedSegments.sort(
    (a, b) => a.startSample - b.startSample || a.endSample - b.endSample
  );

  const outputLiveSegmentBuffer = await createLiveSegmentBuffer({
    sourceAudioBufferId: audioInBufferId,
  });
  try {
    for (const segment of aggregatedSegments) {
      await appendLiveSegment(outputLiveSegmentBuffer.bufferId, {
        kind: 'alignment',
        sourceAudioBufferId: segment.sourceAudioBufferId,
        startSample: segment.startSample,
        endSample: segment.endSample,
        sampleRate: segment.sampleRate,
        durationMs: segment.durationMs,
        ...(typeof segment.confidence === 'number'
          ? { confidence: segment.confidence }
          : {}),
        payload: segment.payload,
      });
    }

    await finalizeLiveSegmentBuffer(outputLiveSegmentBuffer.bufferId);
    try {
      await populateOfflineSegmentBufferIfEmpty(
        segmentOutBufferId,
        outputLiveSegmentBuffer.bufferId,
        'fullIfSpooled'
      );
    } catch (error) {
      throw createAsrMediatedError(
        'ALIGNMENT_OPTIONS_INVALID',
        'Failed to materialize asrMediated output into caller-provided segmentOut buffer.',
        error
      );
    }

    const warnings = toAlignmentWarnings(linkerResult.warnings);
    const warningCode = toWarningCode(warnings);

    return {
      outputSegmentBufferId: segmentOutBufferId,
      segmentsWritten: aggregatedSegments.length,
      ...(typeof linkerResult.linkMapId === 'string' &&
      linkerResult.linkMapId.length > 0
        ? { linkMap: { linkMapId: linkerResult.linkMapId } }
        : {}),
      ...(warningCode ? { warningCode } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } finally {
    await releasePipelineSegmentBuffer(outputLiveSegmentBuffer.bufferId).catch(
      () => {
        // Best-effort cleanup for temporary live segment buffer.
      }
    );
  }
}
