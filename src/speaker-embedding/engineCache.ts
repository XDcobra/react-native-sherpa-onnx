import { createSpeakerEmbeddingEngine } from './engine';
import {
  buildSpeakerEmbeddingInitBridgeOptions,
  speakerEmbeddingEngineCacheKeyFromBridgeOptions,
} from './speakerEmbeddingNativeBridge';
import type {
  SpeakerEmbeddingEngine,
  SpeakerEmbeddingInitializeOptions,
} from './types';

type CacheEntry = {
  engine: SpeakerEmbeddingEngine;
  refCount: number;
};

const cache = new Map<string, CacheEntry>();

/**
 * Acquire a ref-counted {@link SpeakerEmbeddingEngine} keyed by
 * `{ modelKey, provider, numThreads }`. Destroy decrements; native unload at 0.
 *
 * Diarization (Phase 2) should call this to share embedding weights with SID.
 */
export async function acquireSpeakerEmbeddingEngine(
  options: SpeakerEmbeddingInitializeOptions
): Promise<SpeakerEmbeddingEngine> {
  const bridgeOptions = await buildSpeakerEmbeddingInitBridgeOptions(options);
  const cacheKey =
    speakerEmbeddingEngineCacheKeyFromBridgeOptions(bridgeOptions);

  const existing = cache.get(cacheKey);
  if (existing != null) {
    existing.refCount += 1;
    return wrapCachedEngine(cacheKey, existing.engine);
  }

  const engine = await createSpeakerEmbeddingEngine(options);
  cache.set(cacheKey, { engine, refCount: 1 });
  return wrapCachedEngine(cacheKey, engine);
}

function wrapCachedEngine(
  cacheKey: string,
  engine: SpeakerEmbeddingEngine
): SpeakerEmbeddingEngine {
  let released = false;
  return {
    get instanceId() {
      return engine.instanceId;
    },
    get dim() {
      return engine.dim;
    },
    extractFromOfflineAudio: (audio, range) =>
      engine.extractFromOfflineAudio(audio, range),
    async destroy(): Promise<void> {
      if (released) return;
      released = true;
      const entry = cache.get(cacheKey);
      if (entry == null) return;
      entry.refCount -= 1;
      if (entry.refCount > 0) return;
      cache.delete(cacheKey);
      await entry.engine.destroy();
    },
  };
}

/** Test helper: clear the in-memory engine cache. */
export function __resetSpeakerEmbeddingEngineCacheForTests(): void {
  cache.clear();
}
