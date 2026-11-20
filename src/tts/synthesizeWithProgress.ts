import { NativeEventEmitter, NativeModules } from 'react-native';
import SherpaOnnx from '../NativeSherpaOnnx';
import type { TtsSynthesisProgress } from './types';
import {
  createOrchestrationCancelledError,
  throwIfOrchestrationAborted,
} from '../pipeline/cancellation';

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

/**
 * Buffer-to-buffer synthesize with optional Sherpa generate progress (0..1).
 * When `onGenerateProgress` or `signal` is set, native receives `operationId`;
 * progress arrives as `ttsGenerateProgress` events correlated by that id.
 *
 * With `signal`, an abort during the native call asks native to stop at the
 * model's next chunk (`cancelTtsSynthesis`); the call then rejects with
 * `ORCHESTRATION_CANCELLED` and `audioOutBufferId` stays empty.
 *
 * @throws {Error} `ORCHESTRATION_CANCELLED` — `signal` aborted before or during the call.
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

  const subscription = onGenerateProgress
    ? new NativeEventEmitter(NativeModules.SherpaOnnx as any).addListener(
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
      )
    : undefined;

  const onAbort = () => {
    SherpaOnnx.cancelTtsSynthesis(operationId).catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    report(0);
    await SherpaOnnx.synthesizeTts(
      instanceId,
      textInBufferId,
      audioOutBufferId,
      {
        ...(nativeOptions ?? {}),
        operationId,
      }
    );
    report(1);
  } catch (err) {
    if (signal?.aborted) {
      throw createOrchestrationCancelledError();
    }
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    subscription?.remove();
  }
}
