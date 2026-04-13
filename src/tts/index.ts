import SherpaOnnx from '../NativeSherpaOnnx';
import {
  isTtsModelType,
  type TTSInitializeOptions,
  type TTSModelType,
  type TtsModelOptions,
  type TtsUpdateOptions,
  type TtsSynthesisOptions,
  type TTSModelInfo,
  type TtsEngine,
} from './types';
import {
  isDetectionSource,
  type DetectionSource,
  type TtsDetectModelResult,
  type DetectedModelEntry,
} from '../types/modelDetect';
import type { ModelPathConfig } from '../types';
import { resolveModelPath } from '../utils';
import {
  expandTtsInitializeOptions,
  expandTtsUpdateOptions,
  flattenTtsModelOptionsForNative,
  toNativeSynthesisOptions,
} from './ttsNativeBridge';
import { resolvePublicLanguageHints } from '../model-languages';
import { ModelCategory } from '../download/types';
import type {
  OfflineAudioBufferRef,
  OfflineBufferHandle,
} from '../audiobuffer/types';
import type {
  OfflineTextBufferRef,
  OfflineTextBufferHandle,
} from '../textbuffer/types';

let ttsInstanceCounter = 0;

/**
 * Detect TTS model type and structure without initializing the engine.
 * Uses the same native file-based detection as createTTS. Stateless; no instance required.
 * For Kokoro/Kitten multi-language models, the result includes lexiconLanguageCandidates (e.g. ["default"] or ["us-en", "gb-en", "zh"]) derived from lexicon.txt and lexicon-*.txt; use these for a language selection dropdown (language change requires re-initialization).
 *
 * @param modelPath - Model path configuration (asset, file, or auto)
 * @param options - Optional modelType (default: 'auto')
 * @returns Object with success, detectedModels (array of { type, modelDir }),
 * modelType (primary detected type, narrowed to known `TTSModelType` literals),
 * optional error when success is false, optionally lexiconLanguageCandidates
 * (from lexicon files for Kokoro/Kitten), and optionally **languages**, **quantization**, **sizeTier**
 * (`languages`: normalized primary tags, mostly ISO 639-1 from folder/catalog heuristics plus optional SDK hints when empty — not lexicon keys)
 * @example
 * ```typescript
 * const result = await detectTtsModel({ type: 'asset', path: 'models/vits-piper-en' });
 * if (result.success) console.log('Detected type:', result.modelType, result.detectedModels);
 * if (result.lexiconLanguageCandidates?.length) {
 *   // Kokoro/Kitten multi-lang: show language dropdown (e.g. "us-en", "zh")
 * }
 * ```
 */
export async function detectTtsModel(
  modelPath: ModelPathConfig,
  options?: { modelType?: TTSModelType }
): Promise<TtsDetectModelResult> {
  const resolvedPath = await resolveModelPath(modelPath);
  const raw = await SherpaOnnx.detectTtsModel(
    resolvedPath,
    null,
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
 * @param options - TTS initialization options or model path configuration
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
  options: TTSInitializeOptions | ModelPathConfig
): Promise<TtsEngine> {
  const instanceId = `tts_${++ttsInstanceCounter}`;

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

    async synthesize(
      textIn: OfflineTextBufferRef | OfflineTextBufferHandle,
      audioOut: OfflineAudioBufferRef | OfflineBufferHandle,
      opts?: TtsSynthesisOptions
    ): Promise<void> {
      guard();
      const textInIdRaw =
        typeof textIn === 'string'
          ? textIn
          : (textIn as OfflineTextBufferRef).bufferId;
      const audioOutIdRaw =
        typeof audioOut === 'string'
          ? audioOut
          : (audioOut as OfflineAudioBufferRef).bufferId;

      const textInId = textInIdRaw.trim();
      if (textInId.length === 0) {
        throw new Error(
          '[TTS] synthesize requires a non-empty offline text buffer id (textIn).'
        );
      }

      const audioOutId = audioOutIdRaw.trim();
      if (audioOutId.length === 0) {
        throw new Error(
          '[TTS] synthesize requires a non-empty offline audio buffer id (audioOut).'
        );
      }

      await SherpaOnnx.synthesizeTts(
        instanceId,
        textInId,
        audioOutId,
        toNativeSynthesisOptions(opts) ?? undefined
      );
    },

    async updateParams(opts: TtsUpdateOptions): Promise<{
      success: boolean;
      detectedModels: DetectedModelEntry[];
    }> {
      guard();
      const expanded = expandTtsUpdateOptions(opts);
      const effectiveModelTypeForUpdate =
        expanded.modelType && expanded.modelType !== 'auto'
          ? expanded.modelType
          : effectiveModelType;
      const flatOpts = flattenTtsModelOptionsForNative(
        effectiveModelTypeForUpdate,
        expanded.modelOptions
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

// Incremental streaming TTS (higher-level: progressive text feeding + auto-segmentation)
export { createIncrementalStreamingTTS } from './incremental';
export type {
  IncrementalStreamingTtsEngine,
  IncrementalStreamingTtsFactoryOptions,
  IncrementalStreamingTtsSource,
  IncrementalStreamController,
  IncrementalStreamHandlers,
  IncrementalRequestOptions,
  IncrementalMetrics,
  SessionId,
  SegmentId,
  SessionState,
  SegmentationPolicy,
  QueuePolicy,
  QueueMode,
  OverflowStrategy,
  CommitOptions,
  FlushOptions,
  CancelOptions,
  CancelScope,
  SessionEvent,
  SegmentEvent,
} from './incremental';

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
