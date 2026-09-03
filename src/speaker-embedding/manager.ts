import SherpaOnnx from '../NativeSherpaOnnx';
import type { SpeakerEmbeddingManager } from './types';

let speakerEmbeddingManagerCounter = 0;

function flattenEmbeddings(embeddings: Float32Array[], dim: number): number[] {
  const flat: number[] = [];
  for (const emb of embeddings) {
    if (emb.length !== dim) {
      throw new Error(
        `Speaker embedding length ${emb.length} does not match manager dim ${dim}`
      );
    }
    for (let i = 0; i < emb.length; i++) {
      flat.push(emb[i]!);
    }
  }
  return flat;
}

function embeddingToNumberArray(embedding: Float32Array): number[] {
  const out: number[] = new Array(embedding.length);
  for (let i = 0; i < embedding.length; i++) {
    out[i] = embedding[i]!;
  }
  return out;
}

/**
 * Create a native named-speaker manager (enrollment / search / verify).
 * Not used for diarization cluster indices.
 */
export async function createSpeakerEmbeddingManager(
  dim: number
): Promise<SpeakerEmbeddingManager> {
  if (!(dim > 0)) {
    throw new Error('Speaker embedding manager requires dim > 0');
  }
  const managerId = `speakerEmbeddingManager_${++speakerEmbeddingManagerCounter}`;
  const init = await SherpaOnnx.createSpeakerEmbeddingManager(managerId, dim);
  if (!init.success) {
    const nativeError = typeof init.error === 'string' ? init.error.trim() : '';
    throw new Error(
      nativeError.length > 0
        ? `Speaker embedding manager creation failed: ${nativeError}`
        : `Speaker embedding manager creation failed for ${managerId}`
    );
  }

  let destroyed = false;
  const guard = () => {
    if (destroyed) {
      throw new Error(
        `Speaker embedding manager ${managerId} has been destroyed; cannot call methods on it.`
      );
    }
  };

  return {
    get managerId() {
      return managerId;
    },
    get dim() {
      return dim;
    },
    async add(name: string, embeddings: Float32Array[]): Promise<boolean> {
      guard();
      if (embeddings.length === 0) {
        throw new Error('add() requires at least one embedding');
      }
      const flat = flattenEmbeddings(embeddings, dim);
      const result = await SherpaOnnx.speakerEmbeddingManagerAdd(
        managerId,
        name,
        flat,
        embeddings.length
      );
      return result.ok === true;
    },
    async remove(name: string): Promise<boolean> {
      guard();
      const result = await SherpaOnnx.speakerEmbeddingManagerRemove(
        managerId,
        name
      );
      return result.ok === true;
    },
    async search(embedding: Float32Array, threshold: number): Promise<string> {
      guard();
      const result = await SherpaOnnx.speakerEmbeddingManagerSearch(
        managerId,
        embeddingToNumberArray(embedding),
        threshold
      );
      return typeof result.name === 'string' ? result.name : '';
    },
    async verify(
      name: string,
      embedding: Float32Array,
      threshold: number
    ): Promise<boolean> {
      guard();
      const result = await SherpaOnnx.speakerEmbeddingManagerVerify(
        managerId,
        name,
        embeddingToNumberArray(embedding),
        threshold
      );
      return result.ok === true;
    },
    async contains(name: string): Promise<boolean> {
      guard();
      const result = await SherpaOnnx.speakerEmbeddingManagerContains(
        managerId,
        name
      );
      return result.ok === true;
    },
    async numSpeakers(): Promise<number> {
      guard();
      return SherpaOnnx.speakerEmbeddingManagerNumSpeakers(managerId);
    },
    async listSpeakers(): Promise<string[]> {
      guard();
      const result = await SherpaOnnx.speakerEmbeddingManagerAllSpeakerNames(
        managerId
      );
      return Array.isArray(result.names) ? result.names : [];
    },
    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      await SherpaOnnx.destroySpeakerEmbeddingManager(managerId);
    },
  };
}
