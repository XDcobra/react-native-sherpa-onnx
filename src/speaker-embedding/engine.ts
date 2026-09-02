import SherpaOnnx from '../NativeSherpaOnnx';
import {
  createOfflineAudioBufferFromSamples,
  getOfflineAudioBufferSamplesSlice,
  getPipelineAudioBufferInfo,
  releasePipelineAudioBuffer,
  resolvePipelineAudioBufferId,
} from '../audiobuffer';
import type { OfflineAudioBufferIdSource } from '../audiobuffer/types';
import { buildSpeakerEmbeddingInitBridgeOptions } from './speakerEmbeddingNativeBridge';
import type {
  SpeakerEmbeddingEngine,
  SpeakerEmbeddingExtractRange,
  SpeakerEmbeddingInitializeOptions,
} from './types';

let speakerEmbeddingInstanceCounter = 0;

function embeddingArrayToFloat32(values: number[]): Float32Array {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    out[i] = values[i]!;
  }
  return out;
}

/**
 * Create a standalone speaker-embedding extractor engine (no enrollment manager).
 * Prefer {@link acquireSpeakerEmbeddingEngine} when SID and diarization may share weights.
 */
export async function createSpeakerEmbeddingEngine(
  options: SpeakerEmbeddingInitializeOptions
): Promise<SpeakerEmbeddingEngine> {
  const instanceId = `speakerEmbedding_${++speakerEmbeddingInstanceCounter}`;
  const bridgeOptions = await buildSpeakerEmbeddingInitBridgeOptions(options);
  const init = await SherpaOnnx.initializeSpeakerEmbeddingExtractor(
    instanceId,
    bridgeOptions
  );

  if (!init.success) {
    const nativeError = typeof init.error === 'string' ? init.error.trim() : '';
    throw new Error(
      nativeError.length > 0
        ? `Speaker embedding initialization failed: ${nativeError}`
        : `Speaker embedding initialization failed for ${instanceId}`
    );
  }

  const dim = typeof init.dim === 'number' && init.dim > 0 ? init.dim : 0;
  if (dim <= 0) {
    await SherpaOnnx.unloadSpeakerEmbeddingExtractor(instanceId);
    throw new Error(
      `Speaker embedding initialization failed for ${instanceId}: invalid dim`
    );
  }

  let destroyed = false;
  const guard = () => {
    if (destroyed) {
      throw new Error(
        `Speaker embedding instance ${instanceId} has been destroyed; cannot call methods on it.`
      );
    }
  };

  return {
    get instanceId() {
      return instanceId;
    },
    get dim() {
      return dim;
    },
    async extractFromOfflineAudio(
      audio: OfflineAudioBufferIdSource,
      range?: SpeakerEmbeddingExtractRange
    ): Promise<Float32Array> {
      guard();
      const bufferId = resolvePipelineAudioBufferId(audio);

      if (range == null) {
        const result = await SherpaOnnx.computeSpeakerEmbeddingOffline(
          instanceId,
          bufferId
        );
        return embeddingArrayToFloat32(result.embedding ?? []);
      }

      const start = Math.max(0, Math.floor(range.startSample));
      const end = Math.max(start, Math.floor(range.endSample));
      const frameCount = end - start;
      const info = await getPipelineAudioBufferInfo(bufferId);
      const samples =
        frameCount > 0
          ? getOfflineAudioBufferSamplesSlice(audio, start, frameCount)
          : new Float32Array(0);
      const temp = createOfflineAudioBufferFromSamples(
        samples,
        info.sampleRate,
        info.channelCount,
        { targetSampleRateHz: 0 }
      );
      try {
        const result = await SherpaOnnx.computeSpeakerEmbeddingOffline(
          instanceId,
          temp.bufferId
        );
        return embeddingArrayToFloat32(result.embedding ?? []);
      } finally {
        await releasePipelineAudioBuffer(temp.bufferId);
      }
    },
    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      await SherpaOnnx.unloadSpeakerEmbeddingExtractor(instanceId);
    },
  };
}
