import SherpaOnnx from '../../NativeSherpaOnnx';
import {
  createOfflineAudioBufferFromSamples,
  getOfflineAudioBufferSamplesSlice,
  getPipelineAudioBufferInfo,
  releasePipelineAudioBuffer,
  resolvePipelineAudioBufferId,
} from '../../audiobuffer';
import type {
  OfflineAudioBufferInfo,
  OfflineAudioBufferIdSource,
} from '../../audiobuffer/types';
import {
  appendLiveSegment,
  createEmptyOfflineSegmentBuffer,
  createLiveSegmentBuffer,
  finalizeLiveSegmentBuffer,
  getOfflineSegmentBufferSegments,
  getPipelineSegmentBufferInfo,
  populateOfflineSegmentBufferIfEmpty,
  releasePipelineSegmentBuffer,
  resolveOfflineSegmentBufferId,
} from '../../segmentbuffer';
import type {
  AlignmentSegmentMeta,
  OfflineSegmentBufferInfo,
  OfflineSegmentBufferIdSource,
  SpeechSegmentMeta,
} from '../../segmentbuffer/types';
import {
  createOfflineTextBufferFromText,
  getOfflineTextBufferTextSlice,
  getPipelineTextBufferInfo,
  releasePipelineTextBuffer,
  resolveOfflineTextBufferId,
} from '../../textbuffer';
import type {
  OfflineTextBufferIdSource,
  OfflineTextBufferInfo,
} from '../../textbuffer/types';
import { resolveModelPath } from '../../utils';
import { runLinker } from '../linker/linker';
import type {
  AlignmentErrorCode,
  AlignmentWarning,
  AlignmentWarningCode,
  AlignTextToAudioWriteResult,
} from '../types';
import type { LinkerWarning } from '../linker/types';
import type {
  StrategyAAggregatedAlignmentSegment,
  StrategyAAnchor,
  StrategyAAnchorJob,
} from './types';

type StrategyARuntimeError = Error & { code: AlignmentErrorCode };

function createStrategyAError(
  code: AlignmentErrorCode,
  message: string,
  cause?: unknown
): StrategyARuntimeError {
  const error = new Error(`${code}: ${message}`) as StrategyARuntimeError;
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
  throw createStrategyAError(
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
  throw createStrategyAError(
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
  throw createStrategyAError(
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

function toSpeechAnchors(segments: unknown[]): StrategyAAnchor[] {
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
  anchors: StrategyAAnchor[],
  units: StrategyAAnchorJob['mappingUnits']
): StrategyAAnchorJob[] {
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

  const jobs: StrategyAAnchorJob[] = [];
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
  anchor: StrategyAAnchor,
  audioInfo: OfflineAudioBufferInfo
): void {
  if (
    anchor.startSample < 0 ||
    anchor.endSample <= anchor.startSample ||
    anchor.endSample > audioInfo.numSamples
  ) {
    throw createStrategyAError(
      'ALIGNMENT_ANCHOR_OUT_OF_RANGE',
      `Anchor ${anchor.id} exceeds audio bounds (${anchor.startSample}-${anchor.endSample} over 0-${audioInfo.numSamples}).`
    );
  }
}

function toAggregatedSegments(
  anchor: StrategyAAnchor,
  sourceAudioBufferId: string,
  granularity: 'sentence' | 'word',
  localSegments: AlignmentSegmentMeta[]
): StrategyAAggregatedAlignmentSegment[] {
  return localSegments.map((segment) => {
    const localStart = Math.max(0, Math.trunc(segment.startSample));
    const localEnd = Math.max(localStart, Math.trunc(segment.endSample));

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

    const payload = segment.payload;
    const payloadText =
      typeof payload?.text === 'string' && payload.text.trim().length > 0
        ? payload.text
        : '';

    return {
      sourceAudioBufferId,
      startSample,
      endSample,
      sampleRate: anchor.sampleRate,
      durationMs,
      ...(typeof payload?.confidence === 'number'
        ? { confidence: payload.confidence }
        : {}),
      payload: {
        text: payloadText.length > 0 ? payloadText : '[alignment]',
        timingMode: 'accurate',
        granularity,
        ...(typeof payload?.confidence === 'number'
          ? { confidence: payload.confidence }
          : {}),
        ...(payload?.tokenMetadata != null
          ? { tokenMetadata: payload.tokenMetadata }
          : {}),
        ...(payload?.wordMetadata != null
          ? { wordMetadata: payload.wordMetadata }
          : {}),
        ...(Array.isArray(payload?.languageHints)
          ? { languageHints: payload.languageHints }
          : {}),
      },
    };
  });
}

interface RunAccurateStrategyAInput {
  textIn: OfflineTextBufferIdSource;
  audioIn: OfflineAudioBufferIdSource;
  segmentOut: OfflineSegmentBufferIdSource;
  anchorSegmentBuffer: OfflineSegmentBufferIdSource;
  hypothesisTextBuffer: OfflineTextBufferIdSource;
  modelPath: { type: 'asset' | 'file' | 'auto'; path: string };
  granularity?: 'sentence' | 'word';
  language?: string;
}

export async function runAccurateStrategyA(
  input: RunAccurateStrategyAInput
): Promise<AlignTextToAudioWriteResult> {
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
    resolveModelPath(input.modelPath),
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
    throw createStrategyAError(
      'ALIGNMENT_OPTIONS_INVALID',
      'segmentOut must be an empty offline segment buffer for Strategy A output materialization.'
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
    throw createStrategyAError(
      'ALIGNMENT_LINKER_NO_MAPPING',
      'Linker returned no usable mapping units for Strategy A.'
    );
  }

  const anchorsRaw = await getOfflineSegmentBufferSegments(
    anchorSegmentBufferId,
    0,
    anchorInfo.segmentCount ?? 0
  );
  const anchors = toSpeechAnchors(anchorsRaw);
  if (anchors.length === 0) {
    throw createStrategyAError(
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
    throw createStrategyAError(
      'ALIGNMENT_LINKER_NO_MAPPING',
      'No anchor jobs could be materialized from linker units.'
    );
  }

  const aggregatedSegments: StrategyAAggregatedAlignmentSegment[] = [];

  for (const job of jobs) {
    assertAnchorRangeWithinAudio(job.anchor, audioInfo);

    const frameCount = job.anchor.endSample - job.anchor.startSample;
    const slice = getOfflineAudioBufferSamplesSlice(
      audioInBufferId,
      job.anchor.startSample,
      frameCount
    );
    if (slice.length === 0) {
      continue;
    }

    const tmpAudio = createOfflineAudioBufferFromSamples(
      slice,
      audioInfo.sampleRate,
      audioInfo.channelCount
    );

    let tmpText: Awaited<
      ReturnType<typeof createOfflineTextBufferFromText>
    > | null = null;
    let tmpSegmentOut: Awaited<
      ReturnType<typeof createEmptyOfflineSegmentBuffer>
    > | null = null;

    try {
      tmpText = await createOfflineTextBufferFromText(job.referenceText);
      tmpSegmentOut = await createEmptyOfflineSegmentBuffer({
        sourceAudioBufferId: tmpAudio.bufferId,
      });

      try {
        await SherpaOnnx.alignOfflineTextToAudio(
          tmpText.bufferId,
          tmpAudio.bufferId,
          tmpSegmentOut.bufferId,
          'accurate',
          granularity,
          {
            modelPath: resolvedModelPath,
            ...(typeof input.language === 'string' &&
            input.language.trim().length > 0
              ? { language: input.language }
              : {}),
          }
        );
      } catch (error) {
        throw createStrategyAError(
          'ALIGNMENT_NATIVE_ACCURATE_FAILED',
          `Native accurate slice alignment failed for anchor ${job.anchor.id}.`,
          error
        );
      }

      const localSegmentsRaw = await getOfflineSegmentBufferSegments(
        tmpSegmentOut.bufferId,
        0,
        4096
      );
      const localAlignmentSegments = localSegmentsRaw.filter(
        (segment): segment is AlignmentSegmentMeta =>
          segment.kind === 'alignment'
      );
      aggregatedSegments.push(
        ...toAggregatedSegments(
          job.anchor,
          audioInBufferId,
          granularity,
          localAlignmentSegments
        )
      );
    } finally {
      if (tmpSegmentOut != null) {
        await releasePipelineSegmentBuffer(tmpSegmentOut.bufferId).catch(() => {
          // Best-effort cleanup for temporary segment outputs.
        });
      }
      if (tmpText != null) {
        await releasePipelineTextBuffer(tmpText.bufferId).catch(() => {
          // Best-effort cleanup for temporary text slices.
        });
      }
      await releasePipelineAudioBuffer(tmpAudio.bufferId).catch(() => {
        // Best-effort cleanup for temporary audio slices.
      });
    }
  }

  if (aggregatedSegments.length === 0) {
    throw createStrategyAError(
      'ALIGNMENT_LINKER_NO_MAPPING',
      'Strategy A produced no aligned segments after per-anchor accurate runs.'
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
      throw createStrategyAError(
        'ALIGNMENT_OPTIONS_INVALID',
        'Failed to materialize Strategy A output into caller-provided segmentOut buffer.',
        error
      );
    }

    const warnings = toAlignmentWarnings(linkerResult.warnings);
    const warningCode = toWarningCode(warnings);

    return {
      outputSegmentBufferId: segmentOutBufferId,
      segmentsWritten: aggregatedSegments.length,
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
