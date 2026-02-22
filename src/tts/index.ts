import { NativeEventEmitter } from 'react-native';
import SherpaOnnx from '../NativeSherpaOnnx';
import type {
  TTSInitializeOptions,
  TTSModelType,
  TtsModelOptions,
  TtsUpdateOptions,
  TtsGenerationOptions,
  GeneratedAudio,
  GeneratedAudioWithTimestamps,
  TTSModelInfo,
  TtsEngine,
  TtsStreamChunk,
  TtsStreamEnd,
  TtsStreamError,
  TtsStreamHandlers,
} from './types';
import type { ModelPathConfig } from '../types';
import { resolveModelPath } from '../utils';

let ttsInstanceCounter = 0;

/**
 * Flatten model-specific options for the given model type to native init/update params.
 * When modelType is 'auto' or missing, returns undefined for all (native uses defaults).
 */
function flattenTtsModelOptionsForNative(
  modelType: TTSModelType | undefined,
  modelOptions: TtsModelOptions | undefined
): {
  noiseScale: number | undefined;
  noiseScaleW: number | undefined;
  lengthScale: number | undefined;
} {
  if (
    !modelOptions ||
    !modelType ||
    modelType === 'auto' ||
    modelType === 'zipvoice'
  )
    return {
      noiseScale: undefined,
      noiseScaleW: undefined,
      lengthScale: undefined,
    };
  const block =
    modelType === 'vits'
      ? modelOptions.vits
      : modelType === 'matcha'
      ? modelOptions.matcha
      : modelType === 'kokoro'
      ? modelOptions.kokoro
      : modelType === 'kitten'
      ? modelOptions.kitten
      : modelType === 'pocket'
      ? modelOptions.pocket
      : undefined;
  if (!block)
    return {
      noiseScale: undefined,
      noiseScaleW: undefined,
      lengthScale: undefined,
    };
  const out: {
    noiseScale: number | undefined;
    noiseScaleW: number | undefined;
    lengthScale: number | undefined;
  } = {
    noiseScale: undefined,
    noiseScaleW: undefined,
    lengthScale: undefined,
  };
  const n = block as {
    noiseScale?: number;
    noiseScaleW?: number;
    lengthScale?: number;
  };
  if (n.noiseScale !== undefined && typeof n.noiseScale === 'number')
    out.noiseScale = n.noiseScale;
  if (n.noiseScaleW !== undefined && typeof n.noiseScaleW === 'number')
    out.noiseScaleW = n.noiseScaleW;
  if (n.lengthScale !== undefined && typeof n.lengthScale === 'number')
    out.lengthScale = n.lengthScale;
  return out;
}

/**
 * Detect TTS model type and structure without initializing the engine.
 * Uses the same native file-based detection as createTTS. Stateless; no instance required.
 *
 * @param modelPath - Model path configuration (asset, file, or auto)
 * @param options - Optional modelType (default: 'auto')
 * @returns Object with success, detectedModels (array of { type, modelDir }), and modelType (primary detected type)
 * @example
 * ```typescript
 * const result = await detectTtsModel({ type: 'asset', path: 'models/vits-piper-en' });
 * if (result.success) console.log('Detected type:', result.modelType, result.detectedModels);
 * ```
 */
export async function detectTtsModel(
  modelPath: ModelPathConfig,
  options?: { modelType?: TTSModelType }
): Promise<{
  success: boolean;
  detectedModels: Array<{ type: string; modelDir: string }>;
  modelType?: string;
}> {
  const resolvedPath = await resolveModelPath(modelPath);
  return SherpaOnnx.detectTtsModel(resolvedPath, options?.modelType);
}

/**
 * Convert TtsGenerationOptions to a flat object for the native bridge.
 * Flattens referenceAudio { samples, sampleRate } to referenceAudio array + referenceSampleRate.
 */
function toNativeTtsOptions(
  options?: TtsGenerationOptions
): Record<string, unknown> {
  if (options == null) return {};
  const out: Record<string, unknown> = {};
  if (options.sid !== undefined) out.sid = options.sid;
  if (options.speed !== undefined) out.speed = options.speed;
  if (options.silenceScale !== undefined)
    out.silenceScale = options.silenceScale;
  if (options.referenceAudio != null) {
    out.referenceAudio = options.referenceAudio.samples;
    out.referenceSampleRate = options.referenceAudio.sampleRate;
  }
  if (options.referenceText !== undefined)
    out.referenceText = options.referenceText;
  if (options.numSteps !== undefined) out.numSteps = options.numSteps;
  if (options.extra != null && Object.keys(options.extra).length > 0)
    out.extra = options.extra;
  return out;
}

const nativeTtsEventModule =
  SherpaOnnx &&
  typeof (SherpaOnnx as any).addListener === 'function' &&
  typeof (SherpaOnnx as any).removeListeners === 'function'
    ? (SherpaOnnx as any)
    : undefined;

const ttsEventEmitter = new NativeEventEmitter(nativeTtsEventModule);

/**
 * Create a TTS engine instance. Call destroy() on the returned engine when done to free native resources.
 *
 * @param options - TTS initialization options or model path configuration
 * @returns Promise resolving to a TtsEngine instance
 * @example
 * ```typescript
 * const tts = await createTTS({
 *   modelPath: { type: 'asset', path: 'models/vits-piper-en' },
 *   modelType: 'vits',
 *   modelOptions: { vits: { noiseScale: 0.667 } },
 * });
 * const audio = await tts.generateSpeech('Hello world');
 * await tts.destroy();
 * ```
 */
export async function createTTS(
  options: TTSInitializeOptions | ModelPathConfig
): Promise<TtsEngine> {
  const instanceId = `tts_${++ttsInstanceCounter}`;

  let modelPath: ModelPathConfig;
  let modelType: TTSModelType | undefined;
  let numThreads: number | undefined;
  let debug: boolean | undefined;
  let modelOptions: TtsModelOptions | undefined;
  let ruleFsts: string | undefined;
  let ruleFars: string | undefined;
  let maxNumSentences: number | undefined;
  let silenceScale: number | undefined;

  if ('modelPath' in options) {
    modelPath = options.modelPath;
    modelType = options.modelType;
    numThreads = options.numThreads;
    debug = options.debug;
    modelOptions = options.modelOptions;
    ruleFsts = options.ruleFsts;
    ruleFars = options.ruleFars;
    maxNumSentences = options.maxNumSentences;
    silenceScale = options.silenceScale;
  } else {
    modelPath = options;
    modelType = undefined;
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
    silenceScale
  );

  if (!result.success) {
    throw new Error(
      `TTS initialization failed: ${JSON.stringify(
        result.detectedModels ?? []
      )}`
    );
  }

  const firstDetected = result.detectedModels?.[0];
  const effectiveModelType: TTSModelType | undefined =
    modelType && modelType !== 'auto'
      ? modelType
      : (firstDetected?.type as TTSModelType);

  let destroyed = false;

  const guard = () => {
    if (destroyed) {
      throw new Error(
        `TTS instance ${instanceId} has been destroyed; cannot call methods on it.`
      );
    }
  };

  const engine: TtsEngine = {
    get instanceId() {
      return instanceId;
    },

    async generateSpeech(
      text: string,
      opts?: TtsGenerationOptions
    ): Promise<GeneratedAudio> {
      guard();
      return SherpaOnnx.generateTts(instanceId, text, toNativeTtsOptions(opts));
    },

    async generateSpeechWithTimestamps(
      text: string,
      opts?: TtsGenerationOptions
    ): Promise<GeneratedAudioWithTimestamps> {
      guard();
      return SherpaOnnx.generateTtsWithTimestamps(
        instanceId,
        text,
        toNativeTtsOptions(opts)
      );
    },

    async generateSpeechStream(
      text: string,
      opts: TtsGenerationOptions | undefined,
      handlers: TtsStreamHandlers
    ): Promise<() => void> {
      guard();
      const subscriptions = [
        ttsEventEmitter.addListener('ttsStreamChunk', (event: unknown) => {
          const e = event as TtsStreamChunk;
          if (e.instanceId !== instanceId) return;
          handlers.onChunk?.(e);
        }),
        ttsEventEmitter.addListener('ttsStreamEnd', (event: unknown) => {
          const e = event as TtsStreamEnd;
          if (e.instanceId !== instanceId) return;
          handlers.onEnd?.(e);
        }),
        ttsEventEmitter.addListener('ttsStreamError', (event: unknown) => {
          const e = event as TtsStreamError;
          if (e.instanceId !== instanceId) return;
          handlers.onError?.(e);
        }),
      ];

      try {
        await SherpaOnnx.generateTtsStream(
          instanceId,
          text,
          toNativeTtsOptions(opts)
        );
      } catch (error) {
        subscriptions.forEach((sub) => sub.remove());
        throw error;
      }

      return () => {
        subscriptions.forEach((sub) => sub.remove());
      };
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

    async updateParams(opts: TtsUpdateOptions): Promise<{
      success: boolean;
      detectedModels: Array<{ type: string; modelDir: string }>;
    }> {
      guard();
      const effectiveModelTypeForUpdate =
        opts.modelType && opts.modelType !== 'auto'
          ? opts.modelType
          : effectiveModelType;
      const flatOpts = flattenTtsModelOptionsForNative(
        effectiveModelTypeForUpdate,
        opts.modelOptions
      );
      const noiseArg =
        flatOpts.noiseScale === undefined ? Number.NaN : flatOpts.noiseScale;
      const noiseWArg =
        flatOpts.noiseScaleW === undefined ? Number.NaN : flatOpts.noiseScaleW;
      const lengthArg =
        flatOpts.lengthScale === undefined ? Number.NaN : flatOpts.lengthScale;
      return SherpaOnnx.updateTtsParams(
        instanceId,
        noiseArg,
        noiseWArg,
        lengthArg
      );
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

// ========== Module-level utilities (stateless, no instance required) ==========

/**
 * Save generated TTS audio to a WAV file.
 */
export function saveAudioToFile(
  audio: GeneratedAudio,
  filePath: string
): Promise<string> {
  return SherpaOnnx.saveTtsAudioToFile(
    audio.samples,
    audio.sampleRate,
    filePath
  );
}

/**
 * Save generated TTS audio to a WAV file via Android SAF content URI.
 */
export function saveAudioToContentUri(
  audio: GeneratedAudio,
  directoryUri: string,
  filename: string
): Promise<string> {
  return SherpaOnnx.saveTtsAudioToContentUri(
    audio.samples,
    audio.sampleRate,
    directoryUri,
    filename
  );
}

/**
 * Save a text file via Android SAF content URI.
 */
export function saveTextToContentUri(
  text: string,
  directoryUri: string,
  filename: string,
  mimeType = 'text/plain'
): Promise<string> {
  return SherpaOnnx.saveTtsTextToContentUri(
    text,
    directoryUri,
    filename,
    mimeType
  );
}

/**
 * Copy a SAF content URI to a cache file for local playback (Android only).
 */
export function copyContentUriToCache(
  fileUri: string,
  filename: string
): Promise<string> {
  return SherpaOnnx.copyTtsContentUriToCache(fileUri, filename);
}

/**
 * Share a TTS audio file (file path or content URI).
 */
export function shareAudioFile(
  fileUri: string,
  mimeType = 'audio/wav'
): Promise<void> {
  return SherpaOnnx.shareTtsAudio(fileUri, mimeType);
}

// Export types and runtime type list
export type {
  TTSInitializeOptions,
  TTSModelType,
  TtsModelOptions,
  TtsVitsModelOptions,
  TtsMatchaModelOptions,
  TtsKokoroModelOptions,
  TtsKittenModelOptions,
  TtsPocketModelOptions,
  TtsUpdateOptions,
  TtsGenerationOptions,
  SynthesisOptions,
  GeneratedAudio,
  GeneratedAudioWithTimestamps,
  TtsSubtitleItem,
  TTSModelInfo,
  TtsEngine,
  TtsStreamHandlers,
  TtsStreamChunk,
  TtsStreamEnd,
  TtsStreamError,
} from './types';
export { TTS_MODEL_TYPES } from './types';
