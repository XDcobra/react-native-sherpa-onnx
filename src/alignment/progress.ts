import type { OrchestrationProgress } from './types';

/** Range of the current part in the input audio. */
export interface AlignmentProgressRange {
  startSample: number;
  endSample: number;
  sampleRate: number;
}

export interface AlignmentProgressSession {
  emitStep(
    currentSegment: number,
    totalSegments: number,
    currentSegmentDurationMs: number,
    range?: AlignmentProgressRange
  ): void;
}

function sampleToMs(sample: number, sampleRate: number): number {
  return (sample / sampleRate) * 1000;
}

export function createAlignmentProgressSession(
  onProgress: ((progress: OrchestrationProgress) => void) | undefined,
  startedAtMs: number = Date.now()
): AlignmentProgressSession {
  return {
    emitStep(
      currentSegment: number,
      totalSegments: number,
      currentSegmentDurationMs: number,
      range?: AlignmentProgressRange
    ): void {
      if (!onProgress) {
        return;
      }

      const fraction = totalSegments > 0 ? currentSegment / totalSegments : 1;
      onProgress({
        currentSegment,
        totalSegments,
        fraction,
        currentSegmentDurationMs,
        elapsedMs: Date.now() - startedAtMs,
        ...(range != null && range.sampleRate > 0
          ? {
              currentSegmentStartMs: sampleToMs(
                range.startSample,
                range.sampleRate
              ),
              currentSegmentEndMs: sampleToMs(
                range.endSample,
                range.sampleRate
              ),
            }
          : {}),
      });
    },
  };
}
