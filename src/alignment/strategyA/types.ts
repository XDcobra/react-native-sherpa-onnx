import type { LinkerMappingUnit, LinkerResultV0 } from '../linker/types';

export interface StrategyAAnchor {
  id: string;
  startSample: number;
  endSample: number;
  sampleRate: number;
}

export interface StrategyAAnchorJob {
  anchor: StrategyAAnchor;
  referenceText: string;
  mappingUnits: LinkerMappingUnit[];
}

export interface StrategyAAggregatedAlignmentSegment {
  sourceAudioBufferId: string;
  startSample: number;
  endSample: number;
  sampleRate: number;
  durationMs: number;
  confidence?: number;
  payload: {
    text: string;
    timingMode: 'accurate';
    granularity: 'sentence' | 'word';
    confidence?: number;
    tokenMetadata?: Record<string, unknown>;
    wordMetadata?: Record<string, unknown>;
    languageHints?: string[];
  };
}

export interface StrategyAIntermediateResult {
  linkerResult: LinkerResultV0;
  segments: StrategyAAggregatedAlignmentSegment[];
}
