import type { OfflineAudioBufferIdSource } from '../../audiobuffer/types';
import type { OfflineSegmentBufferIdSource } from '../../segmentbuffer/types';
import type { OfflineTextBufferIdSource } from '../../textbuffer/types';

export type LinkerGranularity = 'token' | 'word';

export interface LinkerInput {
  audioIn: OfflineAudioBufferIdSource;
  anchors: OfflineSegmentBufferIdSource;
  referenceText: OfflineTextBufferIdSource;
  hypothesisTextBuffer: OfflineTextBufferIdSource;
  granularity: LinkerGranularity;
  language?: string;
}

export type LinkerWarningCode =
  | 'PARTIAL_COVERAGE'
  | 'LOW_CONFIDENCE_UNIT'
  | 'HYP_TIMESTAMP_GAP'
  | 'ANCHOR_HYP_MISMATCH';

export type LinkerErrorCode =
  | 'ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS'
  | 'ALIGNMENT_LINKER_INPUT_INVALID'
  | 'ALIGNMENT_LINKER_FAILED';

export interface LinkerWarning {
  code: LinkerWarningCode;
  message: string;
  unitIndex?: number;
  anchorIndex?: number;
}

export interface LinkerMappingUnit {
  anchorSegmentId: string;
  anchorStartSample: number;
  anchorEndSample: number;
  referenceStartToken: number;
  referenceEndToken: number;
  refRange: { startCharIndex: number; endCharIndex: number };
  hypRange: { startCharIndex: number; endCharIndex: number };
  audioRangeMs: { startMs: number; endMs: number };
  confidence: number;
  overlapRatio?: number;
}

export interface LinkerResultV0 {
  version: 0;
  status: 'ok' | 'warning';
  mappingUnits: LinkerMappingUnit[];
  globalConfidence: number;
  linkMapId?: string;
  warnings?: LinkerWarning[];
  diagnostics?: {
    refTokenCount?: number;
    hypTokenCount?: number;
    anchorCount?: number;
    coveragePercent?: number;
    elapsedMs?: number;
    medianConfidence?: number;
    minConfidence?: number;
    ambiguousAnchorCount?: number;
    nearestAnchorFallbackCount?: number;
    unassignedAnchorCount?: number;
    unmatchedReferenceTokenCount?: number;
  };
}
