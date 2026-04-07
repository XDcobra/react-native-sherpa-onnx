import { DeviceEventEmitter } from 'react-native';
import SherpaOnnx from '../NativeSherpaOnnx';
import type {
  TTSInitializeOptions,
  TTSModelType,
  TtsModelOptions,
  TtsGenerationOptions,
  TtsStreamChunk,
  TtsStreamEnd,
  TtsStreamError,
  TtsStreamHandlers,
  TtsStreamController,
  TTSModelInfo,
} from './types';
import type { StreamingTtsEngine } from './streamingTypes';
import type { ModelPathConfig } from '../types';
import { resolveModelPath } from '../utils';
import {
  expandTtsInitializeOptions,
  flattenTtsModelOptionsForNative,
  toNativeTtsGenerationOptions,
} from './ttsNativeBridge';

let streamingTtsInstanceCounter = 0;
let ttsRequestIdCounter = 0;

/**
 * Create a streaming TTS engine instance. Use for incremental generation with
 * chunk callbacks and PCM playback. Call destroy() when done.
 *
 * @param options - TTS initialization options or model path configuration
 * @returns Promise resolving to a StreamingTtsEngine instance
 * @example
 * ```typescript
 * const tts = await createStreamingTTS({
 *   modelPath: { type: 'asset', path: 'models/vits-piper-en' },
 *   modelType: 'vits',
 * });
 * const controller = await tts.generateSpeechStream('Hello', undefined, {
 *   onChunk: (chunk) => playPcm(chunk.samples, chunk.sampleRate),
 *   onEnd: () => {},
 * });
 * await tts.destroy();
 * ```
 */
export async function createStreamingTTS(
  options: TTSInitializeOptions | ModelPathConfig
): Promise<StreamingTtsEngine> {
  const instanceId = `streaming_tts_${++streamingTtsInstanceCounter}`;

  let modelPath: ModelPathConfig;
  let modelType: TTSModelType | undefined;
  let provider: string | undefined;
  let numThreads: number | undefined;
  let debug: boolean | undefined;
  let modelOptions: TtsModelOptions | undefined;
  let ruleFsts: string | undefined;
  let ruleFars: string | undefined;
  let maxNumSentences: number | undefined;
  let silenceScale: number | undefined;

  if ('modelPath' in options) {
    const expanded = expandTtsInitializeOptions(options);
    modelPath = expanded.modelPath;
    modelType = expanded.modelType;
    provider = expanded.provider;
    numThreads = expanded.numThreads;
    debug = expanded.debug;
    modelOptions = expanded.modelOptions;
    ruleFsts = expanded.ruleFsts;
    ruleFars = expanded.ruleFars;
    maxNumSentences = expanded.maxNumSentences;
    silenceScale = expanded.silenceScale;
  } else {
    modelPath = options;
    modelType = undefined;
    provider = undefined;
    numThreads = undefined;
    debug = undefined;
    modelOptions = undefined;
    ruleFsts = undefined;
    ruleFars = undefined;
    maxNumSentences = undefined;
    silenceScale = undefined;
  }

  const flat = flattenTtsModelOptionsForNative(modelType, modelOptions);
  const resolvedPath = await resolveModelPath(modelPath);

  const result = await SherpaOnnx.initializeTts(
    instanceId,
    resolvedPath,
    modelType ?? 'auto',
    numThreads ?? 2,
    debug ?? false,
    flat.noiseScale,
    flat.noiseScaleW,
    flat.lengthScale,
    ruleFsts,
    ruleFars,
    maxNumSentences,
    silenceScale,
    provider
  );

  if (!result.success) {
    const nativeError =
      typeof result.error === 'string' ? result.error.trim() : '';
    const detected = JSON.stringify(result.detectedModels ?? []);
    throw new Error(
      nativeError.length > 0
        ? `Streaming TTS initialization failed: ${nativeError}`
        : `Streaming TTS initialization failed: ${detected}`
    );
  }

  let destroyed = false;

  const guard = () => {
    if (destroyed) {
      throw new Error(
        `Streaming TTS instance ${instanceId} has been destroyed; cannot call methods on it.`
      );
    }
  };

  const engine: StreamingTtsEngine = {
    get instanceId() {
      return instanceId;
    },

    async generateSpeechStream(
      text: string,
      opts: TtsGenerationOptions | undefined,
      handlers: TtsStreamHandlers
    ): Promise<TtsStreamController> {
      guard();
      const requestId = `tts_req_${++ttsRequestIdCounter}`;
      const subscriptions: Array<{ remove: () => void }> = [];
      let unsubscribed = false;

      const unsubscribe = () => {
        if (unsubscribed) return;
        unsubscribed = true;
        subscriptions.forEach((sub) => sub.remove());
      };

      const matchesRequest = (e: { instanceId?: string; requestId?: string }) =>
        (e.instanceId == null || e.instanceId === instanceId) &&
        (e.requestId == null || e.requestId === requestId);

      subscriptions.push(
        DeviceEventEmitter.addListener('ttsStreamChunk', (event: unknown) => {
          const e = event as TtsStreamChunk;
          if (!matchesRequest(e)) {
            return;
          }
          handlers.onChunk?.(e);
        }),
        DeviceEventEmitter.addListener('ttsStreamEnd', (event: unknown) => {
          const e = event as TtsStreamEnd;
          if (!matchesRequest(e)) {
            return;
          }
          try {
            handlers.onEnd?.(e);
          } finally {
            unsubscribe();
          }
        }),
        DeviceEventEmitter.addListener('ttsStreamError', (event: unknown) => {
          const e = event as TtsStreamError;
          if (!matchesRequest(e)) {
            return;
          }
          try {
            handlers.onError?.(e);
          } finally {
            unsubscribe();
          }
        })
      );

      // Yield so the bridge can register listeners before native emits (avoids "no listeners" / "already in progress")
      await new Promise<void>((resolve) => {
        if (typeof setImmediate === 'function') {
          setImmediate(resolve);
        } else {
          setTimeout(resolve, 0);
        }
      });

      try {
        await SherpaOnnx.generateTtsStream(
          instanceId,
          requestId,
          text,
          toNativeTtsGenerationOptions(opts)
        );
      } catch (error) {
        unsubscribe();
        throw error;
      }

      const controller: TtsStreamController = {
        async cancel(): Promise<void> {
          guard();
          await SherpaOnnx.cancelTtsStream(instanceId);
          unsubscribe();
        },
        unsubscribe,
      };
      return controller;
    },

    async cancelSpeechStream(): Promise<void> {
      guard();
      return SherpaOnnx.cancelTtsStream(instanceId);
    },

    async startPcmPlayer(sampleRate: number, channels: number): Promise<void> {
      guard();
      return SherpaOnnx.startTtsPcmPlayer(instanceId, sampleRate, channels);
    },

    async writePcmChunk(samples: number[]): Promise<void> {
      guard();
      return SherpaOnnx.writeTtsPcmChunk(instanceId, samples);
    },

    async stopPcmPlayer(): Promise<void> {
      guard();
      return SherpaOnnx.stopTtsPcmPlayer(instanceId);
    },

    async getModelInfo(): Promise<TTSModelInfo> {
      guard();
      const [sampleRate, numSpeakers] = await Promise.all([
        SherpaOnnx.getTtsSampleRate(instanceId),
        SherpaOnnx.getTtsNumSpeakers(instanceId),
      ]);
      return { sampleRate, numSpeakers };
    },

    async getSampleRate(): Promise<number> {
      guard();
      return SherpaOnnx.getTtsSampleRate(instanceId);
    },

    async getNumSpeakers(): Promise<number> {
      guard();
      return SherpaOnnx.getTtsNumSpeakers(instanceId);
    },

    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      await SherpaOnnx.unloadTts(instanceId);
    },
  };

  return engine;
}
