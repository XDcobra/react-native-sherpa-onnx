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
  TtsStreamToFileOptions,
  TtsStreamToFileHandlers,
  TtsStreamFileController,
  TtsStreamFileEnd,
  TtsStreamFileError,
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

// ---------------------------------------------------------------------------
// Internal native event shapes (include routing IDs + binary payload)
// ---------------------------------------------------------------------------

/** Raw chunk event from native — carries base64-encoded PCM and routing IDs. */
interface NativeTtsStreamChunk {
  instanceId?: string;
  requestId?: string;
  /** Base64-encoded little-endian float32 PCM. Empty string for zero-length final chunk. */
  pcmBase64: string;
  sampleRate: number;
  progress: number;
  isFinal: boolean;
}

/** Raw end event from native. */
interface NativeTtsStreamEnd {
  instanceId?: string;
  requestId?: string;
  cancelled: boolean;
}

/** Raw error event from native. */
interface NativeTtsStreamError {
  instanceId?: string;
  requestId?: string;
  message: string;
}

/** Raw file-end event from native. */
interface NativeTtsStreamFileEnd {
  instanceId?: string;
  requestId?: string;
  cancelled: boolean;
  path: string;
  bytesWritten: number;
  sampleRate: number;
}

/** Raw file-error event from native. */
interface NativeTtsStreamFileError {
  instanceId?: string;
  requestId?: string;
  message: string;
  path?: string;
}

// ---------------------------------------------------------------------------
// Binary decoding helpers
// ---------------------------------------------------------------------------

// atob() lookup table — avoids repeated charCodeAt overhead in tight loop
const B64_LOOKUP = new Uint8Array(128);
{
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < chars.length; i++) {
    B64_LOOKUP[chars.charCodeAt(i)] = i;
  }
}

/**
 * Decode a base64 string into a Uint8Array without using atob() (not available
 * in all RN JS engines). Falls back to a pure-JS decoder.
 */
function base64ToBytes(b64: string): Uint8Array {
  // Strip padding
  let len = b64.length;
  if (b64.charCodeAt(len - 1) === 61 /* '=' */) len--;
  if (b64.charCodeAt(len - 1) === 61) len--;
  const byteLen = (len * 3) >> 2;
  const bytes = new Uint8Array(byteLen);
  let p = 0;
  for (let i = 0; i < len; i += 4) {
    const a = B64_LOOKUP[b64.charCodeAt(i)]!;
    const b = B64_LOOKUP[b64.charCodeAt(i + 1)]!;
    const c = B64_LOOKUP[b64.charCodeAt(i + 2)]!;
    const d = B64_LOOKUP[b64.charCodeAt(i + 3)]!;
    bytes[p++] = (a << 2) | (b >> 4);
    if (p < byteLen) bytes[p++] = ((b & 0xf) << 4) | (c >> 2);
    if (p < byteLen) bytes[p++] = ((c & 0x3) << 6) | d;
  }
  return bytes;
}

/** Decode base64-encoded little-endian float32 PCM into Float32Array. */
function decodeBase64ToPcm(b64: string): Float32Array {
  if (!b64 || b64.length === 0) return new Float32Array(0);
  const bytes = base64ToBytes(b64);
  // Create Float32Array view; must copy if not aligned
  if (bytes.byteOffset % 4 === 0 && bytes.byteLength % 4 === 0) {
    return new Float32Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength / 4
    );
  }
  const aligned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(aligned).set(bytes);
  return new Float32Array(aligned);
}

// ---------------------------------------------------------------------------
// Internal → public chunk mapping boundary
// ---------------------------------------------------------------------------

function toPublicStreamChunk(native: NativeTtsStreamChunk): TtsStreamChunk {
  return {
    samples: decodeBase64ToPcm(native.pcmBase64),
    sampleRate: native.sampleRate,
    progress: native.progress,
    isFinal: native.isFinal,
  };
}

function toPublicStreamEnd(native: NativeTtsStreamEnd): TtsStreamEnd {
  return { cancelled: native.cancelled };
}

function toPublicStreamError(native: NativeTtsStreamError): TtsStreamError {
  return { message: native.message };
}

function toPublicStreamFileEnd(
  native: NativeTtsStreamFileEnd
): TtsStreamFileEnd {
  return {
    cancelled: native.cancelled,
    path: native.path,
    bytesWritten: native.bytesWritten,
    sampleRate: native.sampleRate,
  };
}

function toPublicStreamFileError(
  native: NativeTtsStreamFileError
): TtsStreamFileError {
  return { message: native.message, path: native.path };
}

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
          const e = event as NativeTtsStreamChunk;
          if (!matchesRequest(e)) {
            return;
          }
          handlers.onChunk?.(toPublicStreamChunk(e));
        }),
        DeviceEventEmitter.addListener('ttsStreamEnd', (event: unknown) => {
          const e = event as NativeTtsStreamEnd;
          if (!matchesRequest(e)) {
            return;
          }
          try {
            handlers.onEnd?.(toPublicStreamEnd(e));
          } finally {
            unsubscribe();
          }
        }),
        DeviceEventEmitter.addListener('ttsStreamError', (event: unknown) => {
          const e = event as NativeTtsStreamError;
          if (!matchesRequest(e)) {
            return;
          }
          try {
            handlers.onError?.(toPublicStreamError(e));
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

    async generateSpeechStreamToFile(
      text: string,
      opts: TtsGenerationOptions | undefined,
      fileOptions: TtsStreamToFileOptions,
      handlers: TtsStreamToFileHandlers
    ): Promise<TtsStreamFileController> {
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
          const e = event as NativeTtsStreamChunk;
          if (!matchesRequest(e)) return;
          handlers.onChunk?.(toPublicStreamChunk(e));
        }),
        DeviceEventEmitter.addListener('ttsStreamFileEnd', (event: unknown) => {
          const e = event as NativeTtsStreamFileEnd;
          if (!matchesRequest(e)) return;
          try {
            handlers.onEnd?.(toPublicStreamFileEnd(e));
          } finally {
            unsubscribe();
          }
        }),
        DeviceEventEmitter.addListener(
          'ttsStreamFileError',
          (event: unknown) => {
            const e = event as NativeTtsStreamFileError;
            if (!matchesRequest(e)) return;
            try {
              handlers.onError?.(toPublicStreamFileError(e));
            } finally {
              unsubscribe();
            }
          }
        )
      );

      await new Promise<void>((resolve) => {
        if (typeof setImmediate === 'function') {
          setImmediate(resolve);
        } else {
          setTimeout(resolve, 0);
        }
      });

      try {
        await SherpaOnnx.generateTtsStreamToFile(
          instanceId,
          requestId,
          text,
          toNativeTtsGenerationOptions(opts),
          fileOptions
        );
      } catch (error) {
        unsubscribe();
        throw error;
      }

      const controller: TtsStreamFileController = {
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

    async writePcmChunk(samples: Float32Array | number[]): Promise<void> {
      guard();
      const arr =
        samples instanceof Float32Array ? Array.from(samples) : samples;
      return SherpaOnnx.writeTtsPcmChunk(instanceId, arr);
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
