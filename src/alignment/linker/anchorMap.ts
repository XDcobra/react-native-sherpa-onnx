import type { SpeechSegmentMeta } from '../../segmentbuffer/types';
import type { HypothesisTokenSpan, TokenSpan } from './normalize';

export interface AnchorTiming {
  anchorIndex: number;
  anchorSegmentId: string;
  startMs: number;
  endMs: number;
  startSample: number;
  endSample: number;
}

export interface RefHypAssignment {
  refIndex: number;
  hypIndex: number;
  cost: number;
}

export interface GroupedAnchorAssignment {
  anchorIndex: number;
  anchorSegmentId: string;
  anchorStartSample: number;
  anchorEndSample: number;
  referenceStartToken: number;
  referenceEndToken: number;
  refRange: { startCharIndex: number; endCharIndex: number };
  hypRange: { startCharIndex: number; endCharIndex: number };
  audioRangeMs: { startMs: number; endMs: number };
  overlapRatio: number;
  tokenCosts: number[];
  matchedTokenCount: number;
  totalTokenCount: number;
}

export interface AnchorMappingDiagnostics {
  ambiguousAnchorCount: number;
  nearestAnchorFallbackCount: number;
  unmatchedReferenceTokenCount: number;
}

function toAnchorTiming(
  anchor: SpeechSegmentMeta,
  anchorIndex: number
): AnchorTiming {
  const startMs =
    anchor.sampleRate > 0 ? (anchor.startSample / anchor.sampleRate) * 1000 : 0;
  const endMs =
    anchor.sampleRate > 0
      ? (anchor.endSample / anchor.sampleRate) * 1000
      : startMs;
  return {
    anchorIndex,
    anchorSegmentId: anchor.id,
    startMs,
    endMs,
    startSample: anchor.startSample,
    endSample: anchor.endSample,
  };
}

export function createAnchorTimings(
  anchors: SpeechSegmentMeta[]
): AnchorTiming[] {
  return anchors
    .map(toAnchorTiming)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

function clampOverlap(
  startMs: number,
  endMs: number,
  anchor: AnchorTiming
): number {
  const overlapStart = Math.max(startMs, anchor.startMs);
  const overlapEnd = Math.min(endMs, anchor.endMs);
  if (overlapEnd <= overlapStart) {
    return 0;
  }
  const duration = Math.max(1, endMs - startMs);
  return Math.max(0, Math.min(1, (overlapEnd - overlapStart) / duration));
}

export function findAnchorIndexForTimeMs(
  anchorTimings: AnchorTiming[],
  timeMs: number
): { anchorIndex: number; ambiguous: boolean; usedNearest: boolean } {
  if (anchorTimings.length === 0) {
    return { anchorIndex: -1, ambiguous: false, usedNearest: false };
  }

  const containing: number[] = [];
  for (let i = 0; i < anchorTimings.length; i += 1) {
    const anchor = anchorTimings[i];
    if (!anchor) {
      continue;
    }
    if (timeMs >= anchor.startMs && timeMs <= anchor.endMs) {
      containing.push(i);
    }
  }
  if (containing.length === 1) {
    return {
      anchorIndex: containing[0] ?? -1,
      ambiguous: false,
      usedNearest: false,
    };
  }
  if (containing.length > 1) {
    return {
      anchorIndex: containing[0] ?? -1,
      ambiguous: true,
      usedNearest: false,
    };
  }

  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < anchorTimings.length; i += 1) {
    const anchor = anchorTimings[i];
    if (!anchor) {
      continue;
    }
    const distance =
      timeMs < anchor.startMs
        ? anchor.startMs - timeMs
        : timeMs > anchor.endMs
        ? timeMs - anchor.endMs
        : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }

  return { anchorIndex: bestIndex, ambiguous: false, usedNearest: true };
}

export function groupAssignmentsByAnchor(
  refTokens: TokenSpan[],
  hypTokens: HypothesisTokenSpan[],
  assignments: RefHypAssignment[],
  anchorTimings: AnchorTiming[]
): {
  groups: GroupedAnchorAssignment[];
  diagnostics: AnchorMappingDiagnostics;
} {
  const groups: GroupedAnchorAssignment[] = [];
  let unmatchedReferenceTokenCount = 0;
  let ambiguousAnchorCount = 0;
  let nearestAnchorFallbackCount = 0;

  const sortedAssignments = [...assignments]
    .filter((it) => it.refIndex >= 0)
    .sort((a, b) => a.refIndex - b.refIndex);

  let current: GroupedAnchorAssignment | null = null;
  for (const assignment of sortedAssignments) {
    const ref = refTokens[assignment.refIndex];
    if (!ref) {
      continue;
    }

    if (assignment.hypIndex < 0) {
      unmatchedReferenceTokenCount += 1;
      continue;
    }

    const hyp = hypTokens[assignment.hypIndex];
    if (!hyp) {
      unmatchedReferenceTokenCount += 1;
      continue;
    }

    const midpointMs = (hyp.startMs + hyp.endMs) / 2;
    const mapped = findAnchorIndexForTimeMs(anchorTimings, midpointMs);
    if (mapped.anchorIndex < 0) {
      unmatchedReferenceTokenCount += 1;
      continue;
    }
    if (mapped.ambiguous) {
      ambiguousAnchorCount += 1;
    }
    if (mapped.usedNearest) {
      nearestAnchorFallbackCount += 1;
    }

    const anchor = anchorTimings[mapped.anchorIndex];
    if (!anchor) {
      unmatchedReferenceTokenCount += 1;
      continue;
    }
    const shouldStartNewGroup =
      current == null ||
      current.anchorIndex !== mapped.anchorIndex ||
      assignment.refIndex !== current.referenceEndToken;

    if (shouldStartNewGroup) {
      current = {
        anchorIndex: mapped.anchorIndex,
        anchorSegmentId: anchor.anchorSegmentId,
        anchorStartSample: anchor.startSample,
        anchorEndSample: anchor.endSample,
        referenceStartToken: assignment.refIndex,
        referenceEndToken: assignment.refIndex + 1,
        refRange: {
          startCharIndex: ref.startCharIndex,
          endCharIndex: ref.endCharIndex,
        },
        hypRange: {
          startCharIndex: hyp.startCharIndex,
          endCharIndex: hyp.endCharIndex,
        },
        audioRangeMs: {
          startMs: hyp.startMs,
          endMs: hyp.endMs,
        },
        overlapRatio: clampOverlap(hyp.startMs, hyp.endMs, anchor),
        tokenCosts: [assignment.cost],
        matchedTokenCount: 1,
        totalTokenCount: 1,
      };
      groups.push(current);
      continue;
    }

    if (current == null) {
      unmatchedReferenceTokenCount += 1;
      continue;
    }

    current.referenceEndToken = assignment.refIndex + 1;
    current.refRange.endCharIndex = ref.endCharIndex;
    current.hypRange.endCharIndex = hyp.endCharIndex;
    current.audioRangeMs.startMs = Math.min(
      current.audioRangeMs.startMs,
      hyp.startMs
    );
    current.audioRangeMs.endMs = Math.max(
      current.audioRangeMs.endMs,
      hyp.endMs
    );
    current.overlapRatio = Math.max(
      current.overlapRatio,
      clampOverlap(
        current.audioRangeMs.startMs,
        current.audioRangeMs.endMs,
        anchor
      )
    );
    current.tokenCosts.push(assignment.cost);
    current.matchedTokenCount += 1;
    current.totalTokenCount += 1;
  }

  return {
    groups,
    diagnostics: {
      ambiguousAnchorCount,
      nearestAnchorFallbackCount,
      unmatchedReferenceTokenCount,
    },
  };
}
