import SherpaOnnx from '../NativeSherpaOnnx';
import type {
  TTSInitializeOptions,
  TTSModelType,
  TtsModelOptions,
  TTSModelInfo,
} from './types';
import type {
  StreamingTtsEngine,
  TtsPipelineHandle,
  TtsPipelineOptions,
} from './streamingTypes';
import type { StreamingPipelineStatus } from '../audiobuffer/streamingPipelineTypes';
import type { LiveTextBufferIdSource } from '../textbuffer/types';
import {
  getPipelineTextBufferInfo,
  resolvePipelineTextBufferId,
} from '../textbuffer';
import {
  getPipelineAudioBufferInfo,
  resolvePipelineAudioBufferId,
} from '../audiobuffer';
import type {
  LiveAudioBufferIdSource,
  OfflineAudioBufferIdSource,
} from '../audiobuffer/types';
import { createStreamingPipelineCompletionPromise } from '../audiobuffer/streamingPipelineCompletion';
import { attachSegmentationEngine, detachSegmentationEngine } from '../segment';
import { validateSegmentationConfig } from '../segment/validation';
import { resolveFileSourceForModelInit } from '../detect';
import {
  expandTtsInitializeOptions,
  flattenTtsModelOptionsForNative,
} from './ttsNativeBridge';

// ---------------------------------------------------------------------------
// Pipeline options → native bridge mapper
// ---------------------------------------------------------------------------

function toNativePipelineOptions(
  options?: TtsPipelineOptions
): Record<string, unknown> | undefined {
  if (options == null) return undefined;
  const out: Record<string, unknown> = {};
  if (options.sid !== undefined) out.sid = options.sid;
  if (options.speed !== undefined) out.speed = options.speed;
  if (options.voiceClone != null) {
    const vc = options.voiceClone;
    const refBufferId = resolvePipelineAudioBufferId(
      vc.referenceAudio as OfflineAudioBufferIdSource
    );
    out.referenceAudioBufferId = refBufferId;
    if (vc.kind === 'zipvoice') {
      const referenceText = vc.referenceText?.trim() ?? '';
      if (referenceText.length === 0) {
        throw new Error(
          '[TTS] Zipvoice voice cloning requires a non-empty referenceText in voiceClone options.'
        );
      }
      out.referenceText = referenceText;
    } else if (vc.referenceText !== undefined) {
      out.referenceText = vc.referenceText.trim();
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

let streamingTtsInstanceCounter = 0;

function createTtsPipelineHandle(
  instanceId: string,
  pipelineId: string,
  onTerminal: () => void,
  attachedSegmentationEngineId?: string
): TtsPipelineHandle {
  let detached = false;
  const detachIfNeeded = async () => {
    if (!attachedSegmentationEngineId || detached) return;
    detached = true;
    try {
      await detachSegmentationEngine(attachedSegmentationEngineId, {
        flushFinal: true,
      });
    } catch {
      // Best effort: segmentation detach must not mask pipeline shutdown.
    }
  };

  const completed = createStreamingPipelineCompletionPromise(pipelineId)
    .finally(detachIfNeeded)
    .finally(onTerminal);

  return {
    instanceId,
    get pipelineId() {
      return pipelineId;
    },
    completed,
    async stop(): Promise<void> {
      try {
        await SherpaOnnx.stopStreamingPipeline(pipelineId);
      } finally {
        await detachIfNeeded();
        onTerminal();
      }
    },
    async flush(): Promise<void> {
      await SherpaOnnx.flushStreamingPipeline(pipelineId);
    },
    async reset(): Promise<void> {
      await SherpaOnnx.resetStreamingPipeline(pipelineId);
    },
    async getStatus(): Promise<StreamingPipelineStatus> {
      return SherpaOnnx.getStreamingPipelineStatus(pipelineId);
    },
  };
}

/**
 * Create a streaming TTS engine instance backed by native TTS pipelines.
 * Use `tts.synthesize(textIn, audioOut)` to start a pipeline that drains
 * committed text segments and writes PCM samples to the output buffer.
 * Call `destroy()` when done to free native resources.
 *
 * @param options - TTS initialization options
 * @returns Promise resolving to a StreamingTtsEngine instance
 * @example
 * ```typescript
 * const tts = await createStreamingTTS({
 *   modelPath: { type: 'asset', path: 'models/vits-piper-en' },
 *   modelType: 'vits',
 * });
 * const pipeline = await tts.synthesize(textBuffer, audioBuffer);
 * // ... commit text segments to textBuffer ...
 * await pipeline.flush();
 * await pipeline.stop();
 * await tts.destroy();
 * ```
 */
export async function createStreamingTTS(
  options: TTSInitializeOptions
): Promise<StreamingTtsEngine> {
  const instanceId = `streaming_tts_${++streamingTtsInstanceCounter}`;

  const modelSource = options.modelSource;
  let modelType: TTSModelType | undefined;
  let provider: string | undefined;
  let numThreads: number | undefined;
  let debug: boolean | undefined;
  let modelOptions: TtsModelOptions | undefined;
  let ruleFsts: string | undefined;
  let ruleFars: string | undefined;
  let maxNumSentences: number | undefined;
  let silenceScale: number | undefined;

  const expanded = expandTtsInitializeOptions(options);
  modelType = expanded.modelType;
  provider = expanded.provider;
  numThreads = expanded.numThreads;
  debug = expanded.debug;
  modelOptions = expanded.modelOptions;
  ruleFsts = expanded.ruleFsts;
  ruleFars = expanded.ruleFars;
  maxNumSentences = expanded.maxNumSentences;
  silenceScale = expanded.silenceScale;

  const flat = flattenTtsModelOptionsForNative(modelType, modelOptions);
  const resolvedPath = await resolveFileSourceForModelInit(modelSource);

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
  let activePipelineId: string | null = null;

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

    async synthesize(
      textIn: LiveTextBufferIdSource,
      audioOut: LiveAudioBufferIdSource,
      pipelineOptions?: TtsPipelineOptions
    ): Promise<TtsPipelineHandle> {
      guard();

      if (activePipelineId) {
        const status = await SherpaOnnx.getStreamingPipelineStatus(
          activePipelineId
        );
        if (status.isRunning) {
          throw new Error(
            `TTS pipeline already running for engine ${instanceId}`
          );
        }
        activePipelineId = null;
      }

      const textInLiveBufferId = resolvePipelineTextBufferId(textIn);
      const audioOutLiveBufferId = resolvePipelineAudioBufferId(audioOut);

      const [textInfo, audioInfo] = await Promise.all([
        getPipelineTextBufferInfo(textInLiveBufferId),
        getPipelineAudioBufferInfo(audioOutLiveBufferId),
      ]);
      if (textInfo.kind !== 'liveTextBuffer') {
        throw new Error(
          'TTS_INVALID_ARGUMENT: streaming TTS input buffer must be txt_live_*'
        );
      }
      if (audioInfo.kind !== 'livePcmBuffer') {
        throw new Error(
          'TTS_INVALID_ARGUMENT: streaming TTS output buffer must be live_*'
        );
      }

      const segmentation = validateSegmentationConfig({
        mode: pipelineOptions?.segmentation?.mode,
        policy: pipelineOptions?.segmentation?.policy,
        featureName: 'streaming TTS',
        domain: 'text',
        supportsManual: true,
        defaultPolicy: {
          evaluator: 'text_synthetic_auto',
          sentenceBoundary: true,
          maxLengthChars: 500,
        },
      });

      let attachedSegmentationEngineId: string | undefined;
      if (segmentation.mode === 'auto') {
        const attached = await attachSegmentationEngine(textInLiveBufferId, {
          policy: segmentation.policy,
        });
        attachedSegmentationEngineId = attached.engineId;
      }

      try {
        const started = await SherpaOnnx.startTtsPipeline(
          instanceId,
          textInLiveBufferId,
          audioOutLiveBufferId,
          toNativePipelineOptions(pipelineOptions)
        );
        activePipelineId = started.pipelineId;

        return createTtsPipelineHandle(
          instanceId,
          started.pipelineId,
          () => {
            if (activePipelineId === started.pipelineId) {
              activePipelineId = null;
            }
          },
          attachedSegmentationEngineId
        );
      } catch (err) {
        if (attachedSegmentationEngineId) {
          await detachSegmentationEngine(attachedSegmentationEngineId, {
            flushFinal: true,
          }).catch(() => undefined);
        }
        throw err;
      }
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
      if (activePipelineId) {
        try {
          await SherpaOnnx.stopStreamingPipeline(activePipelineId);
        } catch {
          // ignore — pipeline may already be stopped
        }
        activePipelineId = null;
      }
      await SherpaOnnx.unloadTts(instanceId);
    },
  };

  return engine;
}
