import type { LinkerMappingUnit, LinkerResultV0 } from '../linker/types';

export interface AsrMediatedAnchor {
  id: string;
  startSample: number;
  endSample: number;
  sampleRate: number;
}

export interface AsrMediatedAnchorJob {
  anchor: AsrMediatedAnchor;
  referenceText: string;
  mappingUnits: LinkerMappingUnit[];
}

export interface AsrMediatedAggregatedAlignmentSegment {
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

export interface AsrMediatedIntermediateResult {
  linkerResult: LinkerResultV0;
  segments: AsrMediatedAggregatedAlignmentSegment[];
}
