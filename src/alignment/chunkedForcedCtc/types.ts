import type { AlignmentSegmentMeta } from '../../segmentbuffer/types';

export interface ChunkedForcedCtcAnchor {
  id: string;
  startSample: number;
  endSample: number;
  sampleRate: number;
}

export interface ChunkedForcedCtcNativeToken {
  text: string;
  startMs: number;
  endMs: number;
}

export interface ChunkedForcedCtcNativeResult {
  tokens: ChunkedForcedCtcNativeToken[];
  consumedTokenCount: number;
  diagnostics?: {
    ctcBlankRatio?: number;
    framesProcessed?: number;
  };
}

export interface ChunkedForcedCtcCursorUnit {
  text: string;
  startCharIndex: number;
  endCharIndex: number;
}

export interface ChunkedForcedCtcCursorWindow {
  text: string;
  startUnitIndex: number;
  endUnitIndex: number;
  unitCount: number;
  startCharIndex: number;
  endCharIndex: number;
}

export interface ChunkedForcedCtcCursorState {
  sourceText: string;
  units: ChunkedForcedCtcCursorUnit[];
  cursorIndex: number;
  granularity: 'sentence' | 'word';
}

export interface ChunkedForcedCtcAggregatedAlignmentSegment
  extends Omit<AlignmentSegmentMeta, 'kind' | 'id'> {
  kind: 'alignment';
}
