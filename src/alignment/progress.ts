import type { OrchestrationProgress } from './types';

export interface AlignmentProgressSession {
  emitStep(
    currentSegment: number,
    totalSegments: number,
    currentSegmentDurationMs: number
  ): void;
}

export function createAlignmentProgressSession(
  onProgress: ((progress: OrchestrationProgress) => void) | undefined,
  startedAtMs: number = Date.now()
): AlignmentProgressSession {
  return {
    emitStep(
      currentSegment: number,
      totalSegments: number,
      currentSegmentDurationMs: number
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
      });
    },
  };
}
