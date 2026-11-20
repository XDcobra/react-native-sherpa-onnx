import { NativeEventEmitter, NativeModules } from 'react-native';
import SherpaOnnx from '../NativeSherpaOnnx';
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

/**
 * Buffer-to-buffer synthesize with optional Sherpa generate progress (0..1).
 * When `onGenerateProgress` is set, native receives `operationId` and emits
 * `ttsGenerateProgress` events correlated by that id.
 */
export async function synthesizeTtsWithProgress(
  instanceId: string,
  textInBufferId: string,
  audioOutBufferId: string,
  nativeOptions: Record<string, unknown> | undefined,
  onGenerateProgress?: (generateFraction: number) => void
): Promise<void> {
  if (!onGenerateProgress) {
    await SherpaOnnx.synthesizeTts(
      instanceId,
      textInBufferId,
      audioOutBufferId,
      nativeOptions
    );
    return;
  }

  const operationId = `tts_gen_${Date.now()}_${++ttsGenerateProgressOpCounter}`;
  const emitter = new NativeEventEmitter(NativeModules.SherpaOnnx as any);
  let last = 0;
  const report = (raw: number) => {
    const next = Math.max(last, clamp01(raw));
    if (next === last && next !== 0) {
      return;
    }
    last = next;
    onGenerateProgress(next);
  };

  const subscription = emitter.addListener(
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
  } finally {
    subscription.remove();
  }
}
