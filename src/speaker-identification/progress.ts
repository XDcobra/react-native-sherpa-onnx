import type { OrchestrationProgress } from '../pipeline/offlineOrchestrator';

export interface SpeakerIdentificationProgressSession {
  emitStep(
    currentSegment: number,
    totalSegments: number,
    currentSegmentDurationMs: number
  ): void;
}

export function createSpeakerIdentificationProgressSession(
  onProgress: ((progress: OrchestrationProgress) => void) | undefined,
  startedAtMs: number = Date.now()
): SpeakerIdentificationProgressSession {
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
