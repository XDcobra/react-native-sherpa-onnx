import { NativeEventEmitter, NativeModules } from 'react-native';
import SherpaOnnx from '../NativeSherpaOnnx';
import {
  createOrchestrationCancelledError,
  throwIfOrchestrationAborted,
} from '../pipeline/cancellation';
import type { TtsSynthesisProgress } from './types';

let ttsGenerateProgressOpCounter = 0;

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

export function composeTtsFraction(
  segmentIndex: number,
  segmentCount: number,
  generateFraction: number
): number {
  const n = Math.max(1, segmentCount);
  return clamp01((segmentIndex + clamp01(generateFraction)) / n);
}

/**
 * Emit TTS progress with monotonic fraction.
 */
export function createTtsProgressEmitter(
  onProgress: ((progress: TtsSynthesisProgress) => void) | undefined,
  startedAtMs: number
): (
  partial: Omit<TtsSynthesisProgress, 'elapsedMs' | 'fraction'> & {
    fraction?: number;
    elapsedMs?: number;
  }
) => void {
  let lastFraction = 0;
  return (partial) => {
    if (!onProgress) return;
    const fraction = Math.max(
      lastFraction,
      partial.fraction ??
        composeTtsFraction(
          partial.segmentIndex,
          partial.segmentCount,
          partial.generateFraction
        )
    );
    lastFraction = fraction;
    onProgress({
      segmentIndex: partial.segmentIndex,
      segmentCount: partial.segmentCount,
      generateFraction: clamp01(partial.generateFraction),
      fraction,
      elapsedMs: partial.elapsedMs ?? Date.now() - startedAtMs,
    });
  };
}

/** Native reject code of a `synthesizeTts` call stopped by `cancelTtsGeneration`. */
export const TTS_CANCELLED_CODE = 'TTS_CANCELLED';

/**
 * Buffer-to-buffer synthesize with optional Sherpa generate progress (0..1).
 * When `onGenerateProgress` or `signal` is set, native receives `operationId`;
 * progress comes as `ttsGenerateProgress` events correlated by that id, and an
 * abort of `signal` stops generation after the current sentence batch through
 * `cancelTtsGeneration(operationId)`.
 * @throws {Error} `ORCHESTRATION_CANCELLED` (`name: 'AbortError'`) — `signal` aborted before or during the call; `audioOut` stays empty.
 */
export async function synthesizeTtsWithProgress(
  instanceId: string,
  textInBufferId: string,
  audioOutBufferId: string,
  nativeOptions: Record<string, unknown> | undefined,
  onGenerateProgress?: (generateFraction: number) => void,
  signal?: AbortSignal
): Promise<void> {
  throwIfOrchestrationAborted(signal);
  if (!onGenerateProgress && !signal) {
    await SherpaOnnx.synthesizeTts(
      instanceId,
      textInBufferId,
      audioOutBufferId,
      nativeOptions
    );
    return;
  }

  const operationId = `tts_gen_${Date.now()}_${++ttsGenerateProgressOpCounter}`;
  let last = 0;
  const report = (raw: number) => {
    if (!onGenerateProgress) return;
    const next = Math.max(last, clamp01(raw));
    if (next === last && next !== 0) {
      return;
    }
    last = next;
    onGenerateProgress(next);
  };

  // Subscribe even without onGenerateProgress: native emits progress for
  // every call with an operationId.
  const subscription = new NativeEventEmitter(
    NativeModules.SherpaOnnx as any
  ).addListener(
    'ttsGenerateProgress',
    (event: { operationId?: string; progress?: number }) => {
      if (event?.operationId !== operationId) {
        return;
      }
      if (
        typeof event.progress !== 'number' ||
        !Number.isFinite(event.progress)
      ) {
        return;
      }
      report(event.progress);
    }
  );

  const onAbort = () => {
    try {
      SherpaOnnx.cancelTtsGeneration(operationId);
    } catch {
      // Native module without cancel support: the call runs to the end.
    }
  };
  signal?.addEventListener('abort', onAbort);

  try {
    report(0);
    try {
      await SherpaOnnx.synthesizeTts(
        instanceId,
        textInBufferId,
        audioOutBufferId,
        {
          ...(nativeOptions ?? {}),
          operationId,
        }
      );
    } catch (err) {
      if (
        signal?.aborted ||
        (err as { code?: unknown })?.code === TTS_CANCELLED_CODE
      ) {
        throw createOrchestrationCancelledError();
      }
      throw err;
    }
    report(1);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    subscription.remove();
  }
}
