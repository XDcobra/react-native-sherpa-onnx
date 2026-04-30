import { resolvePipelineAudioBufferId } from '../../audiobuffer';
import {
  getOfflineSegmentBufferSegments,
  getPipelineSegmentBufferInfo,
  resolveOfflineSegmentBufferId,
} from '../../segmentbuffer';
import { addSegmentLink, createSegmentLinkMap } from '../../segment';
import type { SpeechSegmentMeta } from '../../segmentbuffer/types';
import {
  getOfflineTextBufferTextSlice,
  getOfflineTextBufferTimestampsSlice,
  getOfflineTextBufferTokensSlice,
  getPipelineTextBufferInfo,
  resolveOfflineTextBufferId,
} from '../../textbuffer';
import { groupAssignmentsByAnchor, createAnchorTimings } from './anchorMap';
import {
  computeGlobalConfidence,
  computeUnitConfidence,
  median,
} from './confidence';
import { alignWithDtw } from './dtw';
import {
  buildHypothesisTokenSpans,
  tokenizeReferenceText,
  type TokenSpan,
} from './normalize';
import type {
  LinkerErrorCode,
  LinkerInput,
  LinkerResultV0,
  LinkerWarning,
} from './types';

type LinkerRuntimeError = Error & { code: LinkerErrorCode };

function createLinkerError(
  code: LinkerErrorCode,
  message: string
): LinkerRuntimeError {
  const error = new Error(`${code}: ${message}`) as LinkerRuntimeError;
  error.code = code;
  return error;
}

function assertNonEmptyString(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw createLinkerError(
      'ALIGNMENT_LINKER_INPUT_INVALID',
      `${field} must be a non-empty string.`
    );
  }
}

function toSpeechAnchors(segments: unknown[]): SpeechSegmentMeta[] {
  return segments.filter(
    (segment): segment is SpeechSegmentMeta =>
      typeof segment === 'object' &&
      segment != null &&
      (segment as { kind?: string }).kind === 'speech'
  );
}

function dedupeWarnings(warnings: LinkerWarning[]): LinkerWarning[] {
  const seen = new Set<string>();
  const out: LinkerWarning[] = [];
  for (const warning of warnings) {
    const key = `${warning.code}|${warning.unitIndex ?? ''}|${
      warning.anchorIndex ?? ''
    }|${warning.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(warning);
  }
  return out;
}

type OfflineTextBufferInfoLike = {
  kind: 'offlineTextBuffer';
  utf16Length?: number;
  tokenCount?: number;
  timestampCount?: number;
};

function asOfflineTextBufferInfo(value: unknown): OfflineTextBufferInfoLike {
  if (
    typeof value === 'object' &&
    value != null &&
    (value as { kind?: unknown }).kind === 'offlineTextBuffer'
  ) {
    return value as OfflineTextBufferInfoLike;
  }
  throw createLinkerError(
    'ALIGNMENT_LINKER_INPUT_INVALID',
    'Linker requires offline text buffers for both reference and hypothesis inputs.'
  );
}

function getCoveragePercent(
  refTokens: TokenSpan[],
  mappedTokenCount: number
): number {
  if (refTokens.length === 0) {
    return 0;
  }
  return Math.round((mappedTokenCount / refTokens.length) * 1000) / 10;
}

async function materializeLinkMap(
  input: LinkerInput,
  units: LinkerResultV0['mappingUnits']
): Promise<string | undefined> {
  if (units.length === 0) {
    return undefined;
  }

  const textBufferId = resolveOfflineTextBufferId(input.referenceText);
  const audioBufferId = resolvePipelineAudioBufferId(input.audioIn);
  const map = await createSegmentLinkMap({ textBufferId, audioBufferId });

  for (const unit of units) {
    await addSegmentLink(map, {
      textSegmentId: `ref_${unit.referenceStartToken}_${unit.referenceEndToken}`,
      speechSegmentId: unit.anchorSegmentId,
      linkType: 'alignment',
      confidence: unit.confidence,
      meta: {
        refRange: unit.refRange,
        hypRange: unit.hypRange,
        audioRangeMs: unit.audioRangeMs,
      },
    });
  }

  return map.linkMapId;
}

export async function runLinker(input: LinkerInput): Promise<LinkerResultV0> {
  const startedAt = Date.now();
  const warnings: LinkerWarning[] = [];

  const referenceTextId = resolveOfflineTextBufferId(input.referenceText);
  const hypothesisBufferId = resolveOfflineTextBufferId(
    input.hypothesisTextBuffer
  );
  const anchorBufferId = resolveOfflineSegmentBufferId(input.anchors);

  assertNonEmptyString(referenceTextId, 'referenceText');
  assertNonEmptyString(hypothesisBufferId, 'hypothesisTextBuffer');
  assertNonEmptyString(anchorBufferId, 'anchors');

  const [referenceInfo, hypothesisInfo, anchorInfo] = await Promise.all([
    getPipelineTextBufferInfo(referenceTextId),
    getPipelineTextBufferInfo(hypothesisBufferId),
    getPipelineSegmentBufferInfo(anchorBufferId),
  ]);
  const referenceOfflineInfo = asOfflineTextBufferInfo(referenceInfo);
  const hypothesisOfflineInfo = asOfflineTextBufferInfo(hypothesisInfo);

  if (
    hypothesisOfflineInfo.timestampCount == null ||
    hypothesisOfflineInfo.timestampCount <= 0
  ) {
    throw createLinkerError(
      'ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS',
      'The ASR hypothesis buffer does not contain token timestamps.'
    );
  }

  if ((referenceOfflineInfo.utf16Length ?? 0) <= 0) {
    throw createLinkerError(
      'ALIGNMENT_LINKER_INPUT_INVALID',
      'Reference text buffer is empty.'
    );
  }
  if ((hypothesisOfflineInfo.tokenCount ?? 0) <= 0) {
    throw createLinkerError(
      'ALIGNMENT_LINKER_INPUT_INVALID',
      'Hypothesis token buffer is empty.'
    );
  }

  const [
    referenceText,
    hypothesisTokens,
    hypothesisTimestamps,
    anchorSegmentsRaw,
  ] = await Promise.all([
    getOfflineTextBufferTextSlice(
      referenceTextId,
      0,
      referenceOfflineInfo.utf16Length ?? 0
    ),
    getOfflineTextBufferTokensSlice(
      hypothesisBufferId,
      0,
      hypothesisOfflineInfo.tokenCount ?? 0
    ),
    getOfflineTextBufferTimestampsSlice(
      hypothesisBufferId,
      0,
      hypothesisOfflineInfo.timestampCount ?? 0
    ),
    getOfflineSegmentBufferSegments(
      anchorBufferId,
      0,
      anchorInfo.segmentCount ?? 0
    ),
  ]);

  if (hypothesisTimestamps.length < hypothesisTokens.length) {
    throw createLinkerError(
      'ALIGNMENT_LINKER_FAILED',
      `Hypothesis token/timestamp mismatch (${hypothesisTokens.length} tokens, ${hypothesisTimestamps.length} timestamps).`
    );
  }

  const refTokens = tokenizeReferenceText(
    referenceText,
    input.granularity,
    input.language
  );
  if (refTokens.length === 0) {
    throw createLinkerError(
      'ALIGNMENT_LINKER_INPUT_INVALID',
      'Reference text has no comparable tokens after normalization.'
    );
  }

  const hypTokens = buildHypothesisTokenSpans(
    hypothesisTokens,
    hypothesisTimestamps,
    input.language
  );
  if (hypTokens.length === 0) {
    throw createLinkerError(
      'ALIGNMENT_LINKER_INPUT_INVALID',
      'Hypothesis has no comparable tokens after normalization.'
    );
  }

  const anchors = toSpeechAnchors(anchorSegmentsRaw);
  if (anchors.length === 0) {
    throw createLinkerError(
      'ALIGNMENT_LINKER_INPUT_INVALID',
      'Anchor segment buffer must contain at least one speech segment.'
    );
  }

  const dtw = alignWithDtw(
    refTokens.map((it) => it.normalized),
    hypTokens.map((it) => it.normalized)
  );

  const anchorTimings = createAnchorTimings(anchors);
  const grouped = groupAssignmentsByAnchor(
    refTokens,
    hypTokens,
    dtw.pairs,
    anchorTimings
  );

  const mappingUnits: LinkerResultV0['mappingUnits'] = grouped.groups.map(
    (group) => {
      const meanCost =
        group.tokenCosts.length > 0
          ? group.tokenCosts.reduce((sum, value) => sum + value, 0) /
            group.tokenCosts.length
          : 1;
      const confidence = computeUnitConfidence({
        meanTokenCost: meanCost,
        overlapRatio: group.overlapRatio,
        matchedTokenCount: group.matchedTokenCount,
        totalTokenCount: group.totalTokenCount,
      });

      return {
        anchorSegmentId: group.anchorSegmentId,
        anchorStartSample: group.anchorStartSample,
        anchorEndSample: group.anchorEndSample,
        referenceStartToken: group.referenceStartToken,
        referenceEndToken: group.referenceEndToken,
        refRange: group.refRange,
        hypRange: group.hypRange,
        audioRangeMs: {
          startMs: Math.round(group.audioRangeMs.startMs),
          endMs: Math.round(group.audioRangeMs.endMs),
        },
        confidence,
        overlapRatio: Math.round(group.overlapRatio * 1000) / 1000,
      };
    }
  );

  if (mappingUnits.length === 0) {
    throw createLinkerError(
      'ALIGNMENT_LINKER_FAILED',
      'No mapping units were produced by linker alignment.'
    );
  }

  for (let i = 0; i < mappingUnits.length; i += 1) {
    const unit = mappingUnits[i];
    if (!unit) {
      continue;
    }
    if (unit.confidence < 0.45) {
      warnings.push({
        code: 'LOW_CONFIDENCE_UNIT',
        message: 'Unit confidence is below threshold (< 0.45).',
        unitIndex: i,
      });
    }
  }

  if (grouped.diagnostics.ambiguousAnchorCount > 0) {
    warnings.push({
      code: 'ANCHOR_HYP_MISMATCH',
      message: 'Some hypothesis timestamps intersected multiple anchors.',
    });
  }

  if (grouped.diagnostics.nearestAnchorFallbackCount > 0) {
    warnings.push({
      code: 'HYP_TIMESTAMP_GAP',
      message:
        'Some hypothesis timestamps were outside all anchors and required nearest-anchor mapping.',
    });
  }

  const coveragePercent = getCoveragePercent(
    refTokens,
    refTokens.length - grouped.diagnostics.unmatchedReferenceTokenCount
  );
  if (coveragePercent < 100) {
    warnings.push({
      code: 'PARTIAL_COVERAGE',
      message: `Reference coverage is partial (${coveragePercent}%).`,
    });
  }

  let linkMapId: string | undefined;
  try {
    linkMapId = await materializeLinkMap(input, mappingUnits);
  } catch (error) {
    throw createLinkerError(
      'ALIGNMENT_LINKER_FAILED',
      `Failed to materialize segment link map: ${(error as Error).message}`
    );
  }

  const confidences = mappingUnits.map((unit) => unit.confidence);
  const weights = mappingUnits.map((unit) =>
    Math.max(1, unit.referenceEndToken - unit.referenceStartToken)
  );
  const globalConfidence = computeGlobalConfidence(confidences, weights);

  const status = warnings.length > 0 ? 'warning' : 'ok';
  const elapsedMs = Date.now() - startedAt;
  const minConfidence = confidences.length > 0 ? Math.min(...confidences) : 0;

  return {
    version: 0,
    status,
    mappingUnits,
    globalConfidence,
    ...(linkMapId != null ? { linkMapId } : {}),
    ...(warnings.length > 0 ? { warnings: dedupeWarnings(warnings) } : {}),
    diagnostics: {
      refTokenCount: refTokens.length,
      hypTokenCount: hypTokens.length,
      anchorCount: anchors.length,
      coveragePercent,
      elapsedMs,
      medianConfidence: Math.round(median(confidences) * 1000) / 1000,
      minConfidence: Math.round(minConfidence * 1000) / 1000,
      ambiguousAnchorCount: grouped.diagnostics.ambiguousAnchorCount,
      nearestAnchorFallbackCount:
        grouped.diagnostics.nearestAnchorFallbackCount,
      unassignedAnchorCount: Math.max(0, anchors.length - mappingUnits.length),
      unmatchedReferenceTokenCount:
        grouped.diagnostics.unmatchedReferenceTokenCount,
    },
  };
}
