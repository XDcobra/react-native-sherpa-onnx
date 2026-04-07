import { Platform } from 'react-native';
import SherpaOnnx from '../NativeSherpaOnnx';
import {
  isTtsDetectionSource,
  isTtsModelType,
  type TTSInitializeOptions,
  type TTSModelType,
  type TtsModelOptions,
  type TtsUpdateOptions,
  type TtsGenerationOptions,
  type GeneratedAudio,
  type GeneratedAudioWithTimestamps,
  type TTSModelInfo,
  type TtsEngine,
  type TtsDetectedModelEntry,
  type SaveAudioTarget,
  type SaveAudioOptions,
  type TtsDetectionSource,
} from './types';
import type { ModelPathConfig } from '../types';
import { resolveModelPath } from '../utils';
import {
  alignTextToAudio,
  assertAlignmentGranularityForMode,
} from '../alignment/alignTextToAudio';
import {
  expandTtsInitializeOptions,
  expandTtsUpdateOptions,
  flattenTtsModelOptionsForNative,
  toNativeTtsGenerationOptions,
} from './ttsNativeBridge';

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
 * (name-based heuristics from the folder/asset stem — same keys as native / download catalog metadata)
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
): Promise<{
  success: boolean;
  /** Native validation/detect failure (e.g. missing lexicon for Zipvoice). */
  error?: string;
  detectedModels: TtsDetectedModelEntry[];
  /** Primary detected kind, narrowed to known SDK literals. */
  modelType?: TTSModelType;
  /** Language ids from detected lexicon files ("default" for lexicon.txt, or e.g. "us-en", "zh" from lexicon-us-en.txt, lexicon-zh.txt). Present for Kokoro/Kitten; use for language selection UI. */
  lexiconLanguageCandidates?: string[];
  /** Heuristic language tags from the folder / asset basename (catalog-style); not from lexicon files. */
  languages?: string[];
  /** fp16, int8, int8-quantized, unknown — from name heuristics. */
  quantization?: string;
  /** tiny, small, medium, large, unknown — from name heuristics. */
  sizeTier?: string;
  /** Trace of how native detection chose the model kind (omitted if native returned nothing). */
  detectionSources?: readonly TtsDetectionSource[];
}> {
  const resolvedPath = await resolveModelPath(modelPath);
  const raw = await SherpaOnnx.detectTtsModel(
    resolvedPath,
    null,
    options?.modelType ?? null
  );
  const err = typeof raw.error === 'string' ? raw.error.trim() : '';
  const detectedModels: TtsDetectedModelEntry[] = (
    raw.detectedModels ?? []
  ).map((m) => ({
    type: m.type,
    modelDir: m.modelDir,
  }));
  const detectionSources: TtsDetectionSource[] = [];
  const rawSources = raw.detectionSources;
  if (Array.isArray(rawSources)) {
    for (const s of rawSources) {
      if (typeof s === 'string' && isTtsDetectionSource(s)) {
        detectionSources.push(s);
      }
    }
  }
  const modelType =
    typeof raw.modelType === 'string' && isTtsModelType(raw.modelType)
      ? raw.modelType
      : undefined;
  const derivedLanguages =
    Array.isArray(raw.languages) && raw.languages.length > 0
      ? raw.languages.filter((x): x is string => typeof x === 'string')
      : undefined;
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
    ...(derivedLanguages != null && derivedLanguages.length > 0
      ? { languages: derivedLanguages }
      : {}),
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

    async generateSpeech(
      text: string,
      opts?: TtsGenerationOptions
    ): Promise<GeneratedAudio> {
      guard();
      const optionsWithSubtitlesOff: TtsGenerationOptions = {
        ...(opts ?? {}),
        subtitles: { mode: 'off' },
      };
      return SherpaOnnx.generateTts(
        instanceId,
        text,
        toNativeTtsGenerationOptions(optionsWithSubtitlesOff)
      );
    },

    async generateSpeechWithTimestamps(
      text: string,
      opts?: TtsGenerationOptions
    ): Promise<GeneratedAudioWithTimestamps> {
      guard();
      const subs = opts?.subtitles;
      const subtitleMode = subs?.mode ?? 'proportional';
      const subtitleGranularity = subs?.granularity ?? 'sentence';

      if (subtitleMode !== 'off') {
        assertAlignmentGranularityForMode(
          subtitleMode === 'accurate' ? 'aligned' : subtitleMode,
          subtitleGranularity
        );
      }

      if (subtitleMode === 'off') {
        const audio = await SherpaOnnx.generateTts(
          instanceId,
          text,
          toNativeTtsGenerationOptions({
            ...(opts ?? {}),
            subtitles: { mode: 'off' },
          })
        );
        return { ...audio, subtitles: [], timingMode: 'off' };
      }

      if (subs?.mode === 'accurate') {
        const alignmentModelPath = subs.alignmentModelPath.trim();
        if (!alignmentModelPath) {
          throw new Error(
            'ALIGNMENT_MODEL_MISSING: Provide subtitles.alignmentModelPath for accurate mode.'
          );
        }

        const optionsWithSubtitlesOff: TtsGenerationOptions = {
          ...(opts ?? {}),
          subtitles: { mode: 'off' },
        };

        const generated = await SherpaOnnx.generateTts(
          instanceId,
          text,
          toNativeTtsGenerationOptions(optionsWithSubtitlesOff)
        );

        const subtitleResult = await alignTextToAudio(
          text,
          { samples: generated.samples, sampleRate: generated.sampleRate },
          {
            mode: 'accurate',
            granularity: subtitleGranularity,
            alignmentModelPath,
          }
        );

        return {
          ...generated,
          subtitles: subtitleResult.subtitles,
          timingMode: 'aligned',
        };
      }

      const gran =
        subtitleGranularity === 'character' ? 'sentence' : subtitleGranularity;

      if (subtitleMode === 'proportional') {
        const generated = await SherpaOnnx.generateTts(
          instanceId,
          text,
          toNativeTtsGenerationOptions({
            ...(opts ?? {}),
            subtitles: { mode: 'off' },
          })
        );
        const subtitleResult = await alignTextToAudio(
          text,
          { samples: generated.samples, sampleRate: generated.sampleRate },
          { mode: 'proportional', granularity: gran }
        );
        return {
          ...generated,
          subtitles: subtitleResult.subtitles,
          timingMode: subtitleResult.timingMode,
        };
      }

      if (subtitleMode === 'estimated') {
        const raw = await SherpaOnnx.generateTtsWithTimestamps(
          instanceId,
          text,
          toNativeTtsGenerationOptions(opts ?? {}, {
            exportChunkTimelineOnly: true,
            subtitleMode: 'estimated',
            subtitleGranularity: gran,
          })
        );
        const counts = raw.segmentSampleCounts;
        if (!counts || !Array.isArray(counts)) {
          throw new Error(
            'TTS_CHUNK_TIMELINE: native did not return segmentSampleCounts; ensure exportChunkTimelineOnly is supported.'
          );
        }
        const subtitleResult = await alignTextToAudio(
          text,
          { samples: raw.samples, sampleRate: raw.sampleRate },
          {
            mode: 'estimated',
            chunks: {
              sampleRate: raw.sampleRate,
              segmentSampleCounts: counts.map((n) => Number(n)),
            },
            granularity: gran,
          }
        );
        return {
          samples: raw.samples,
          sampleRate: raw.sampleRate,
          subtitles: subtitleResult.subtitles,
          timingMode: subtitleResult.timingMode,
        };
      }

      throw new Error(`Unsupported subtitles.mode: ${String(subtitleMode)}`);
    },

    async updateParams(opts: TtsUpdateOptions): Promise<{
      success: boolean;
      detectedModels: TtsDetectedModelEntry[];
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

// ========== Module-level utilities (stateless, no instance required) ==========

/**
 * Save generated TTS audio to a file or (Android) SAF tree. Default format is `wav`.
 * For non-WAV formats, native encodes from float PCM without requiring the app to write a WAV first.
 *
 * @returns Absolute file path, or on Android SAF a `content://` URI string.
 */
export function saveAudio(
  audio: GeneratedAudio,
  target: SaveAudioTarget,
  options?: SaveAudioOptions
): Promise<string> {
  const format = (options?.format ?? 'wav').trim().toLowerCase() || 'wav';
  const outputSampleRateHz = options?.outputSampleRateHz ?? 0;

  if (target.kind === 'androidContent') {
    if (Platform.OS !== 'android') {
      return Promise.reject(
        new Error(
          'saveAudio: kind "androidContent" is only supported on Android.'
        )
      );
    }
    return SherpaOnnx.saveTtsAudio(
      audio.samples,
      audio.sampleRate,
      'androidContent',
      target.directoryUri,
      target.filename,
      format,
      outputSampleRateHz
    );
  }

  return SherpaOnnx.saveTtsAudio(
    audio.samples,
    audio.sampleRate,
    'file',
    target.path,
    '',
    format,
    outputSampleRateHz
  );
}

// Streaming TTS (separate engine; use createStreamingTTS for chunk callbacks and PCM playback)
export { createStreamingTTS } from './streaming';
export type { StreamingTtsEngine } from './streamingTypes';

export {
  alignTextToAudio,
  assertAlignmentGranularityForMode,
} from '../alignment/alignTextToAudio';
export type {
  AlignTextToAudioOptions,
  AlignTextToAudioResult,
  AlignmentChunkTimeline,
  SubtitleTimingItem,
} from '../alignment/types';

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
  TtsGenerationOptions,
  TtsReferenceAudio,
  TtsExecutionProvider,
  TtsVoiceClone,
  TtsVoiceCloneZipvoice,
  TtsVoiceClonePocket,
  TtsDetectedModelEntry,
  TtsDetectionSource,
  SubtitleMode,
  SubtitleGranularity,
  SubtitleOptions,
  SubtitleOptionsAccurate,
  SubtitleOptionsProportionalOrEstimated,
  GeneratedAudio,
  GeneratedAudioWithTimestamps,
  TtsSubtitleItem,
  TTSModelInfo,
  SaveAudioTarget,
  SaveAudioTargetFile,
  SaveAudioTargetAndroidContent,
  SaveAudioOptions,
  TtsEngine,
  TtsStreamController,
  TtsStreamHandlers,
  TtsStreamChunk,
  TtsStreamEnd,
  TtsStreamError,
  TtsStreamFileOutput,
  TtsStreamToFileOptions,
  TtsStreamToFileHandlers,
  TtsStreamFileController,
  TtsStreamFileEnd,
  TtsStreamFileError,
} from './types';
export {
  TTS_MODEL_TYPES,
  TTS_DETECTION_SOURCES,
  isTtsDetectionSource,
  isTtsModelType,
} from './types';
