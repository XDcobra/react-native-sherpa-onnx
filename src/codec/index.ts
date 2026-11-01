/**
 * Shared HW/SW codec policy — public API for react-native-sherpa-onnx/codec.
 */

import {
  NativeEventEmitter,
  NativeModules,
  TurboModuleRegistry,
} from 'react-native';
import type { Spec } from '../NativeSherpaOnnx';
import type {
  CodecEvent,
  CodecInfo,
  CodecPolicy,
  CodecResource,
  ConfigureCodecsOptions,
} from './types';
import { CODEC_POLICIES, CODEC_RESOURCES } from './types';

const getNative = (): Spec =>
  TurboModuleRegistry.getEnforcing<Spec>('SherpaOnnx');

function assertPolicy(value: CodecPolicy | undefined, field: string): void {
  if (value === undefined) return;
  if (!CODEC_POLICIES.includes(value)) {
    throw new Error(
      `CODEC_INVALID_ARGUMENT: ${field} must be hardware | software | preferHardware`
    );
  }
}

function assertBudget(value: number | undefined, field: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1 || value > 4) {
    throw new Error(
      `CODEC_INVALID_ARGUMENT: budgets.${field} must be an integer in [1, 4]`
    );
  }
}

/**
 * Set global video/image codec policy and slot budgets (1–4).
 * @throws {Error} `CODEC_INVALID_ARGUMENT` — policy is not `hardware` | `software` | `preferHardware`, or a budget is outside 1–4.
 */
export async function configureCodecs(
  options?: ConfigureCodecsOptions
): Promise<void> {
  assertPolicy(options?.video?.decode, 'video.decode');
  assertPolicy(options?.video?.display, 'video.display');
  assertPolicy(options?.video?.encode, 'video.encode');
  assertPolicy(options?.image?.decode, 'image.decode');
  assertPolicy(options?.image?.encode, 'image.encode');
  const budgets = options?.budgets;
  if (budgets) {
    for (const key of CODEC_RESOURCES) {
      assertBudget(budgets[key], key);
    }
    for (const key of Object.keys(budgets) as CodecResource[]) {
      if (!CODEC_RESOURCES.includes(key)) {
        throw new Error(
          `CODEC_INVALID_ARGUMENT: unknown budget resource '${key}'`
        );
      }
    }
  }
  await getNative().configureCodecs({
    video: options?.video,
    image: options?.image,
    budgets: options?.budgets,
  });
}

/**
 * Snapshot of RAM class, slot `max` / `inUse`, and catalog providers.
 * @throws {Error} `CODEC_INVALID_ARGUMENT` — native returned an empty codec-info payload.
 */
export async function getCodecInfo(): Promise<CodecInfo> {
  const raw = await getNative().getCodecInfo();
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('CODEC_INVALID_ARGUMENT: empty codec info');
  }
  const info = JSON.parse(raw) as CodecInfo;
  if (__DEV__) {
    console.log('[SherpaOnnx:codec] getCodecInfo', {
      ramClass: info.ramClass,
      providers: Array.isArray(info.providers) ? info.providers.length : -1,
    });
  }
  return info;
}

export function subscribeCodecEvents(
  listener: (event: CodecEvent) => void
): () => void {
  const emitter = new NativeEventEmitter(
    NativeModules.SherpaOnnx ?? (getNative() as never)
  );
  const sub = emitter.addListener('SherpaOnnxCodecEvent', (raw: unknown) => {
    let evt: unknown = raw;
    if (typeof raw === 'string') {
      try {
        evt = JSON.parse(raw);
      } catch {
        return;
      }
    }
    const payload =
      evt && typeof evt === 'object' && 'payload' in evt
        ? (evt as { payload?: unknown }).payload
        : evt;
    let parsed: unknown = payload;
    if (typeof payload === 'string') {
      try {
        parsed = JSON.parse(payload);
      } catch {
        return;
      }
    }
    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
      return;
    }
    listener(parsed as CodecEvent);
  });
  return () => sub.remove();
}

export type {
  CodecAttempt,
  CodecDecision,
  CodecEvent,
  CodecInfo,
  CodecOrigin,
  CodecPolicy,
  CodecResource,
  CodecTier,
  CodecUnavailableReason,
  ConfigureCodecsOptions,
} from './types';
