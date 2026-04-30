import type { AlignmentSegmentMeta } from '../../segmentbuffer/types';

export interface StrategyBAnchor {
  id: string;
  startSample: number;
  endSample: number;
  sampleRate: number;
}

export interface StrategyBNativeToken {
  text: string;
  startMs: number;
  endMs: number;
}

export interface StrategyBNativeResult {
  tokens: StrategyBNativeToken[];
  consumedTokenCount: number;
  diagnostics?: {
    ctcBlankRatio?: number;
    framesProcessed?: number;
  };
}

export interface StrategyBCursorUnit {
  text: string;
  startCharIndex: number;
  endCharIndex: number;
}

export interface StrategyBCursorWindow {
  text: string;
  startUnitIndex: number;
  endUnitIndex: number;
  unitCount: number;
  startCharIndex: number;
  endCharIndex: number;
}

export interface StrategyBCursorState {
  sourceText: string;
  units: StrategyBCursorUnit[];
  cursorIndex: number;
  granularity: 'sentence' | 'word';
}

export interface StrategyBAggregatedAlignmentSegment
  extends Omit<AlignmentSegmentMeta, 'kind' | 'id'> {
  kind: 'alignment';
}
