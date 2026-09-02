import type { OfflineAudioBufferIdSource } from '../audiobuffer/types';
import { acquireSpeakerEmbeddingEngine } from '../speaker-embedding/engineCache';
import { createSpeakerEmbeddingManager } from '../speaker-embedding/manager';
import type {
  IdentifyResult,
  SpeakerIdentificationEngine,
  SpeakerIdentificationOptions,
  SpeakerIdentificationThresholdOptions,
} from './types';

export type {
  IdentifyResult,
  SpeakerIdentificationEngine,
  SpeakerIdentificationOptions,
  SpeakerIdentificationThresholdOptions,
} from './types';

const DEFAULT_THRESHOLD = 0.5;

function resolveThreshold(
  options?: SpeakerIdentificationThresholdOptions
): number {
  const t = options?.threshold;
  return typeof t === 'number' && Number.isFinite(t) ? t : DEFAULT_THRESHOLD;
}

/**
 * Create a Speaker Identification engine on the shared embedding extractor +
 * named-speaker manager. The extractor is ref-counted so future diarization
 * can share the same model weights via `acquireSpeakerEmbeddingEngine`.
 */
export async function createSpeakerIdentification(
  options: SpeakerIdentificationOptions
): Promise<SpeakerIdentificationEngine> {
  const engine = await acquireSpeakerEmbeddingEngine(options);
  const manager = await createSpeakerEmbeddingManager(engine.dim);

  let destroyed = false;
  const guard = () => {
    if (destroyed) {
      throw new Error(
        `Speaker identification instance ${engine.instanceId} has been destroyed; cannot call methods on it.`
      );
    }
  };

  return {
    get instanceId() {
      return engine.instanceId;
    },
    get managerId() {
      return manager.managerId;
    },
    get dim() {
      return engine.dim;
    },
    async enroll(
      name: string,
      audio: OfflineAudioBufferIdSource | OfflineAudioBufferIdSource[]
    ): Promise<void> {
      guard();
      const trimmed = name.trim();
      if (trimmed.length === 0) {
        throw new Error('enroll() requires a non-empty speaker name');
      }
      const buffers = Array.isArray(audio) ? audio : [audio];
      if (buffers.length === 0) {
        throw new Error('enroll() requires at least one audio buffer');
      }
      const embeddings: Float32Array[] = [];
      for (const buffer of buffers) {
        embeddings.push(await engine.extractFromOfflineAudio(buffer));
      }
      const ok = await manager.add(trimmed, embeddings);
      if (!ok) {
        throw new Error(
          `Failed to enroll speaker '${trimmed}' (name may already exist)`
        );
      }
    },
    async identify(
      audio: OfflineAudioBufferIdSource,
      thresholdOptions?: SpeakerIdentificationThresholdOptions
    ): Promise<IdentifyResult> {
      guard();
      const embedding = await engine.extractFromOfflineAudio(audio);
      const name = await manager.search(
        embedding,
        resolveThreshold(thresholdOptions)
      );
      const trimmed = name.trim();
      return { name: trimmed.length > 0 ? trimmed : null };
    },
    async verify(
      name: string,
      audio: OfflineAudioBufferIdSource,
      thresholdOptions?: SpeakerIdentificationThresholdOptions
    ): Promise<boolean> {
      guard();
      const embedding = await engine.extractFromOfflineAudio(audio);
      return manager.verify(
        name,
        embedding,
        resolveThreshold(thresholdOptions)
      );
    },
    async removeSpeaker(name: string): Promise<boolean> {
      guard();
      return manager.remove(name);
    },
    async listSpeakers(): Promise<string[]> {
      guard();
      return manager.listSpeakers();
    },
    async contains(name: string): Promise<boolean> {
      guard();
      return manager.contains(name);
    },
    async numSpeakers(): Promise<number> {
      guard();
      return manager.numSpeakers();
    },
    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      await manager.destroy();
      await engine.destroy();
    },
  };
}
