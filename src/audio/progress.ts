import type { AudioSaveProgressEvent } from './types';

/** Phase order: events from an earlier phase than the last forwarded one are dropped. */
const PHASE_RANK: Record<AudioSaveProgressEvent['phase'], number> = {
  decode: 0,
  encode: 1,
  finalize: 2,
};

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/**
 * Forwards native `audioSaveProgress` events of one save operation to `onProgress`.
 *
 * Native code already throttles (about every 1 % or 100 ms). This layer only makes the
 * sequence the caller sees well-formed:
 * - events of other operations, unknown phases and malformed payloads are ignored;
 * - percent is clamped to 0–100 and never goes back within a phase, and a phase never
 *   goes back (`decode` → `encode` → `finalize`);
 * - repeats that do not advance (same percent, no new frames) are dropped;
 * - after `finalize` nothing more is forwarded.
 *
 * `complete()` is called once the native save resolved. It sends the final
 * `finalize` / 100 % event if the native one has not arrived yet, so the caller always
 * sees 100 % before the promise resolves. Like the native final event it reports the
 * frames written so far as both `framesProcessed` and `totalFramesEstimate`.
 */
export interface AudioSaveProgressForwarder {
  handle(rawEvent: unknown): void;
  complete(): void;
}

export function createAudioSaveProgressForwarder(
  operationId: string,
  onProgress: (event: AudioSaveProgressEvent) => void
): AudioSaveProgressForwarder {
  let lastRank = -1;
  let lastPercent = -1;
  let lastFrames = -1;
  let finalized = false;

  const forward = (event: AudioSaveProgressEvent) => {
    lastRank = PHASE_RANK[event.phase];
    lastPercent = event.percent;
    lastFrames = event.framesProcessed;
    if (event.phase === 'finalize') finalized = true;
    try {
      onProgress(event);
    } catch {
      // A failing progress callback must not fail or interrupt the save.
    }
  };

  return {
    handle(rawEvent: unknown) {
      if (finalized || typeof rawEvent !== 'object' || rawEvent === null) {
        return;
      }
      const raw = rawEvent as Record<string, unknown>;
      if (raw.operationId !== operationId) return;
      const phase = raw.phase as AudioSaveProgressEvent['phase'];
      if (typeof phase !== 'string' || !(phase in PHASE_RANK)) return;

      const rank = PHASE_RANK[phase];
      const framesProcessed = finiteNonNegative(raw.framesProcessed);
      const totalFramesEstimate = finiteNonNegative(raw.totalFramesEstimate);
      const percent = Math.min(100, finiteNonNegative(raw.percent));

      if (rank < lastRank) return;
      if (rank === lastRank) {
        if (percent < lastPercent) return;
        if (percent === lastPercent && framesProcessed <= lastFrames) return;
      }
      forward({
        operationId,
        phase,
        framesProcessed,
        totalFramesEstimate,
        percent,
      });
    },

    complete() {
      if (finalized) return;
      const frames = Math.max(0, lastFrames);
      forward({
        operationId,
        phase: 'finalize',
        framesProcessed: frames,
        totalFramesEstimate: frames,
        percent: 100,
      });
    },
  };
}
