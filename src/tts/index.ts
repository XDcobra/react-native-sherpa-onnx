import SherpaOnnx from '../NativeSherpaOnnx';
import {
  isTtsModelType,
  type TTSInitializeOptions,
  type TTSModelType,
  type TtsModelOptions,
  type TtsUpdateOptions,
  type TtsSynthesisOptions,
  type TtsSynthesisResult,
  type TTSModelInfo,
  type TtsEngine,
  type TtsLivePipelineOptions,
} from './types';
import {
  isDetectionSource,
  type DetectionSource,
  type TtsDetectModelResult,
  type DetectedModelEntry,
} from '../types/modelDetect';
import type { FileSource } from '../fileio/types';
import {
  resolveFileSourceForDetect,
  resolveFileSourceForModelInit,
} from '../detect';
import {
  expandTtsInitializeOptions,
  expandTtsUpdateOptions,
  flattenTtsModelOptionsForNative,
  toNativeSynthesisOptions,
} from './ttsNativeBridge';
import { resolvePublicLanguageHints } from '../model-languages';
import { ModelCategory } from '../download/types';
import {
  releasePipelineAudioBuffer,
  resolvePipelineAudioBufferId,
  subscribeLiveAudioBufferEvents,
} from '../audiobuffer';
import { resolvePipelineTextBufferId } from '../textbuffer';
import { addSegmentLink, createSegmentLinkMap } from '../segment';
import { validateSegmentationConfig } from '../segment/validation';
import type {
  OfflineAudioBufferRef,
  OfflineBufferHandle,
  LiveAudioBufferIdSource,
  LiveAudioBufferRef,
} from '../audiobuffer/types';
import type {
  OfflineTextBufferRef,
  OfflineTextBufferHandle,
  LiveTextBufferIdSource,
  LiveTextBufferRef,
} from '../textbuffer/types';
import { runOfflineTtsPipeline } from './orchestrate';
import { validateLiveOfflinePipelineOptions } from '../livePipeline';
import {
  attachSegmentationEngine,
  detachSegmentationEngine,
  getSegmentationEngineInfo,
} from '../segment';
import { createStreamingPipelineCompletionPromise } from '../audiobuffer/streamingPipelineCompletion';
import type { TtsPipelineHandle } from './streamingTypes';
import type { SpeechSegment } from '../segment/segment';

let ttsInstanceCounter = 0;

function isLiveAudioSource(buffer: unknown): buffer is LiveAudioBufferIdSource {
  if (typeof buffer === 'string') return buffer.startsWith('live_');
  if (
    typeof buffer === 'object' &&
    buffer !== null &&
    'info' in buffer &&
    typeof (buffer as LiveAudioBufferRef).info === 'object' &&
    (buffer as LiveAudioBufferRef).info?.kind === 'livePcmBuffer'
  ) {
    return true;
  }
  return false;
}

function isLiveTextSource(buffer: unknown): buffer is LiveTextBufferIdSource {
  if (typeof buffer === 'string') return buffer.startsWith('txt_live_');
  if (
    typeof buffer === 'object' &&
    buffer !== null &&
    'info' in buffer &&
    typeof (buffer as LiveTextBufferRef).info === 'object' &&
    (buffer as LiveTextBufferRef).info?.kind === 'liveTextBuffer'
  ) {
    return true;
  }
  return false;
}

function createTtsPipelineHandle(
  instanceId: string,
  pipelineId: string,
  attachedEngineId?: string
): TtsPipelineHandle {
  const completed = createStreamingPipelineCompletionPromise(pipelineId);
  return {
    instanceId,
    pipelineId,
    completed,
    async stop(): Promise<void> {
      await SherpaOnnx.stopStreamingPipeline(pipelineId);
      if (attachedEngineId) {
        await detachSegmentationEngine(attachedEngineId).catch(() => undefined);
      }
    },
    async flush(): Promise<void> {
      await SherpaOnnx.flushStreamingPipeline(pipelineId);
    },
    async reset(): Promise<void> {
      await SherpaOnnx.resetStreamingPipeline(pipelineId);
    },
    async getStatus() {
      return SherpaOnnx.getStreamingPipelineStatus(pipelineId);
    },
  };
}

function toNativeOfflineLivePipelineOptions(
  options: TtsLivePipelineOptions
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (options.sid !== undefined) out.sid = options.sid;
  if (options.speed !== undefined) out.speed = options.speed;
  if (options.voiceClone != null) {
    const vc = options.voiceClone;
    out.referenceAudioBufferId = resolvePipelineAudioBufferId(
      vc.referenceAudio
    );
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
  return out;
}

async function synthesizeLiveOverload(
  instanceId: string,
  textIn: LiveTextBufferIdSource,
  audioOut: LiveAudioBufferIdSource,
  options: TtsLivePipelineOptions
): Promise<TtsPipelineHandle> {
  const { policy } = validateLiveOfflinePipelineOptions({
    featureName: 'live offline TTS',
    domain: 'text',
    segmentation: options.segmentation,
  });

  const inId = resolvePipelineTextBufferId(textIn);
  const outId = resolvePipelineAudioBufferId(audioOut);

  const attached = await attachSegmentationEngine(textIn, { policy });

  let engineInfo: Awaited<ReturnType<typeof getSegmentationEngineInfo>>;
  try {
    engineInfo = await getSegmentationEngineInfo(attached.engineId);
  } catch (err) {
    await detachSegmentationEngine(attached.engineId, {
      flushFinal: false,
    }).catch(() => undefined);
    throw err;
  }

  const segmentLiveBufferId = engineInfo.segmentBufferId;
  if (!segmentLiveBufferId) {
    await detachSegmentationEngine(attached.engineId, {
      flushFinal: false,
    }).catch(() => undefined);
    throw new Error(
      'TTS_ERROR: segmentation engine did not produce a segment buffer for text domain'
    );
  }

  let pipelineId: string;
  try {
    const result = await SherpaOnnx.startTtsOfflineLivePipeline(
      instanceId,
      inId,
      outId,
      {
        attachedSegmentationEngineId: attached.engineId,
        segmentLiveBufferId,
        ...toNativeOfflineLivePipelineOptions(options),
      }
    );
    pipelineId = result.pipelineId;
  } catch (err) {
    await detachSegmentationEngine(attached.engineId, {
      flushFinal: false,
    }).catch(() => undefined);
    throw err;
  }

  const handle = createTtsPipelineHandle(
    instanceId,
    pipelineId,
    attached.engineId
  );

  if (options.onSegment) {
    const cb = options.onSegment;
    const unsub = subscribeLiveAudioBufferEvents(audioOut, {
      onSegment: (event) => {
        cb(event.segment as SpeechSegment);
      },
    });
    handle.completed.then(unsub, unsub);
  }

  return handle;
}

/**
 * Detect TTS model type and structure without initializing the engine.
 * Uses the same native file-based detection as createTTS. Stateless; no instance required.
 * For Kokoro/Kitten multi-language models, the result includes lexiconLanguageCandidates (e.g. ["default"] or ["us-en", "gb-en", "zh"]) derived from lexicon.txt and lexicon-*.txt; use these for a language selection dropdown (language change requires re-initialization).
 *
 * @param source - FileSource describing where to find the model
 * @param options - Optional modelType (default: 'auto')
 * @returns Object with success, detectedModels, modelType, isStreaming (always true for TTS),
 * optional error, lexiconLanguageCandidates, languages, quantization, sizeTier
 * @example
 * ```typescript
 * const result = await detectTtsModel({ kind: 'fs', path: '/path/to/vits-piper-en' });
 * if (result.success) console.log('Detected type:', result.modelType, result.detectedModels);
 * if (result.lexiconLanguageCandidates?.length) {
 *   // Kokoro/Kitten multi-lang: show language dropdown (e.g. "us-en", "zh")
 * }
 * ```
 */
export async function detectTtsModel(
  source: FileSource,
  options?: { modelType?: TTSModelType }
): Promise<TtsDetectModelResult> {
  const resolved = await resolveFileSourceForDetect(source);
  const raw = await SherpaOnnx.detectTtsModel(
    resolved.modelDir,
    resolved.assetName,
    options?.modelType ?? null
  );
  const err = typeof raw.error === 'string' ? raw.error.trim() : '';
  const detectedModels: DetectedModelEntry[] = (raw.detectedModels ?? []).map(
    (m) => ({
      type: m.type,
      modelDir: m.modelDir,
    })
  );
  const detectionSources: DetectionSource[] = [];
  const rawSources = raw.detectionSources;
  if (Array.isArray(rawSources)) {
    for (const s of rawSources) {
      if (typeof s === 'string' && isDetectionSource(s)) {
        detectionSources.push(s);
      }
    }
  }
  const modelType =
    typeof raw.modelType === 'string' && isTtsModelType(raw.modelType)
      ? raw.modelType
      : undefined;
  const rawLanguageStrings =
    Array.isArray(raw.languages) && raw.languages.length > 0
      ? raw.languages.filter((x): x is string => typeof x === 'string')
      : [];
  const resolvedLanguages = resolvePublicLanguageHints({
    domain: ModelCategory.Tts,
    modelType,
    rawFromNative: rawLanguageStrings,
  });
  const quantization =
    typeof raw.quantization === 'string' && raw.quantization.length > 0
      ? raw.quantization
      : undefined;
  const sizeTier =
    typeof raw.sizeTier === 'string' && raw.sizeTier.length > 0
      ? raw.sizeTier
      : undefined;
  return {
    success: raw.success,
    isStreaming: true,
    ...(err.length > 0 ? { error: err } : {}),
    detectedModels,
    ...(modelType != null ? { modelType } : {}),
    ...(raw.lexiconLanguageCandidates != null &&
    raw.lexiconLanguageCandidates.length > 0
      ? { lexiconLanguageCandidates: raw.lexiconLanguageCandidates }
      : {}),
    ...(resolvedLanguages.length > 0 ? { languages: resolvedLanguages } : {}),
    ...(quantization != null ? { quantization } : {}),
    ...(sizeTier != null ? { sizeTier } : {}),
    ...(detectionSources.length > 0 ? { detectionSources } : {}),
  };
}

// TTS stream events are sent from native via sendEventWithName; use DeviceEventEmitter

/**
 * Create a TTS engine instance. Call destroy() on the returned engine when done to free native resources.
 *
 * @param options - TTS initialization options
 * @returns Promise resolving to a TtsEngine instance
 * @example
 * ```typescript
 * const tts = await createTTS({
 *   modelPath: { type: 'asset', path: 'models/vits-piper-en' },
 *   modelType: 'vits',
 *   modelOptions: { vits: { noiseScale: 0.667 } },
 * });
 * const sr = await tts.getSampleRate();
 * const textBuf = await createOfflineTextBufferFromText('Hello world');
 * const audioBuf = await createEmptyOfflineAudioBuffer(sr);
 * await tts.synthesize(textBuf, audioBuf);
 * await tts.destroy();
 * ```
 */
export async function createTTS(
  options: TTSInitializeOptions
): Promise<TtsEngine> {
  const instanceId = `tts_${++ttsInstanceCounter}`;

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
        ? `TTS initialization failed: ${nativeError}`
        : `TTS initialization failed: ${detected}`
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

    synthesize: (async (
      textIn:
        | OfflineTextBufferRef
        | OfflineTextBufferHandle
        | LiveTextBufferIdSource,
      audioOut:
        | OfflineAudioBufferRef
        | OfflineBufferHandle
        | LiveAudioBufferIdSource,
      opts?: TtsSynthesisOptions | TtsLivePipelineOptions
    ): Promise<TtsSynthesisResult | TtsPipelineHandle> => {
      guard();

      const textIsLive = isLiveTextSource(textIn);
      const audioIsLive = isLiveAudioSource(audioOut);

      if (textIsLive || audioIsLive) {
        if (!(textIsLive && audioIsLive)) {
          throw new Error(
            'TTS_INVALID_ARGUMENT: synthesize() overload mismatch. Use (OfflineText, OfflineAudio, options?) for batch or (LiveText, LiveAudio, options) for live pipeline.'
          );
        }
        return synthesizeLiveOverload(
          instanceId,
          textIn as LiveTextBufferIdSource,
          audioOut as LiveAudioBufferIdSource,
          opts as TtsLivePipelineOptions
        );
      }

      // Batch path
      const batchOpts = opts as TtsSynthesisOptions | undefined;
      const startedAtMs = Date.now();
      const textInId = resolvePipelineTextBufferId(
        textIn as OfflineTextBufferRef | OfflineTextBufferHandle
      );
      const audioOutId = resolvePipelineAudioBufferId(
        audioOut as OfflineAudioBufferRef | OfflineBufferHandle
      );

      const segmentation = validateSegmentationConfig({
        mode: batchOpts?.segmentation?.mode,
        policy: batchOpts?.segmentation?.policy,
        featureName: 'offline TTS',
        domain: 'text',
        supportsManual: false,
        defaultPolicy: {
          evaluator: 'text_synthetic_auto',
          sentenceBoundary: true,
          maxLengthChars: 500,
        },
        errorPrefix: 'SEGMENTATION_POLICY_INVALID',
      });

      if (segmentation.mode === 'off') {
        await SherpaOnnx.synthesizeTts(
          instanceId,
          textInId,
          audioOutId,
          toNativeSynthesisOptions(batchOpts) ?? undefined
        );
        return {
          status: 'complete',
          totalSegments: 1,
          completedSegments: 1,
          skippedSegments: [],
          processingTimeMs: Date.now() - startedAtMs,
          linkMap: batchOpts?.linkMap,
        };
      }

      const orchestrated = await runOfflineTtsPipeline(
        textInId,
        instanceId,
        batchOpts ?? {}
      );

      let linkMap = orchestrated.linkMap ?? batchOpts?.linkMap;
      if (!linkMap && orchestrated.segmentMappings.length > 0) {
        linkMap = await createSegmentLinkMap({
          textBufferId: textInId,
          audioBufferId: audioOutId,
        });
      }

      if (linkMap) {
        for (const mapping of orchestrated.segmentMappings) {
          await addSegmentLink(linkMap, {
            textSegmentId: mapping.textSegmentId,
            speechSegmentId: mapping.speechSegmentId,
            linkType: 'tts_produced',
          });
        }
      }

      if (orchestrated.outputBuffer) {
        try {
          await SherpaOnnx.populateOfflineAudioBufferIfEmpty(
            audioOutId,
            orchestrated.outputBuffer.bufferId,
            undefined
          );
        } finally {
          await releasePipelineAudioBuffer(
            orchestrated.outputBuffer.bufferId
          ).catch(() => undefined);
        }
      }

      return {
        status: orchestrated.status,
        totalSegments: orchestrated.totalSegments,
        completedSegments: orchestrated.completedSegments,
        skippedSegments: orchestrated.skippedSegments,
        ...(orchestrated.failedSegment
          ? { failedSegment: orchestrated.failedSegment }
          : {}),
        processingTimeMs: orchestrated.processingTimeMs,
        ...(linkMap ? { linkMap } : {}),
      };
    }) as TtsEngine['synthesize'],

    async updateParams(opts: TtsUpdateOptions): Promise<{
      success: boolean;
      detectedModels: DetectedModelEntry[];
    }> {
      guard();
      const updateExpanded = expandTtsUpdateOptions(opts);
      const effectiveModelTypeForUpdate =
        updateExpanded.modelType && updateExpanded.modelType !== 'auto'
          ? updateExpanded.modelType
          : effectiveModelType;
      const flatOpts = flattenTtsModelOptionsForNative(
        effectiveModelTypeForUpdate,
        updateExpanded.modelOptions
      );
      const noiseArg =
        flatOpts.noiseScale === undefined ? Number.NaN : flatOpts.noiseScale;
      const noiseWArg =
        flatOpts.noiseScaleW === undefined ? Number.NaN : flatOpts.noiseScaleW;
      const lengthArg =
        flatOpts.lengthScale === undefined ? Number.NaN : flatOpts.lengthScale;
      const raw = await SherpaOnnx.updateTtsParams(
        instanceId,
        noiseArg,
        noiseWArg,
        lengthArg
      );
      return {
        success: raw.success,
        detectedModels: (raw.detectedModels ?? []).map((m) => ({
          type: m.type,
          modelDir: m.modelDir,
        })),
      };
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

// Streaming TTS (pipeline-based; use createStreamingTTS for native pipeline streaming)
export { createStreamingTTS } from './streaming';
export type {
  StreamingTtsEngine,
  TtsPipelineHandle,
  TtsPipelineOptions,
} from './streamingTypes';

// Export types and runtime type list
export type {
  TTSInitializeOptions,
  TTSInitializeOptionsAuto,
  TTSInitializeOptionsBase,
  TTSInitializeOptionsVits,
  TTSInitializeOptionsMatcha,
  TTSInitializeOptionsKokoro,
  TTSInitializeOptionsKitten,
  TTSInitializeOptionsPocket,
  TTSInitializeOptionsZipvoice,
  TTSInitializeOptionsSupertonic,
  TTSModelType,
  TtsModelOptions,
  TtsVitsModelOptions,
  TtsMatchaModelOptions,
  TtsKokoroModelOptions,
  TtsKittenModelOptions,
  TtsPocketModelOptions,
  TtsSupertonicModelOptions,
  TtsUpdateOptions,
  TtsUpdateOptionsEmpty,
  TtsSynthesisOptions,
  TtsSynthesisResult,
  TtsExecutionProvider,
  TtsVoiceClone,
  TtsVoiceCloneZipvoice,
  TtsVoiceClonePocket,
  SubtitleMode,
  SubtitleGranularity,
  TTSModelInfo,
  SaveAudioTarget,
  SaveAudioTargetFile,
  SaveAudioTargetAndroidContent,
  TtsEngine,
  TtsLivePipelineOptions,
} from './types';
export { TTS_MODEL_TYPES, isTtsModelType } from './types';
export {
  DETECTION_SOURCES,
  isDetectionSource,
  type DetectionSource,
  type DetectedModelEntry,
  type ModelDetectResultBase,
  type TtsDetectModelResult,
  type AlignmentDetectModelResult,
} from '../types/modelDetect';
