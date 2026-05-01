import SherpaOnnx from '../NativeSherpaOnnx';
import { resolvePipelineAudioBufferId } from '../audiobuffer';
import {
  getOfflineTextBufferTextSlice,
  getPipelineTextBufferInfo,
  releasePipelineTextBuffer,
  resolvePipelineTextBufferId,
} from '../textbuffer';
import type {
  OfflineAudioBufferRef,
  OfflineBufferHandle,
} from '../audiobuffer/types';
import type {
  OfflineTextBufferRef,
  OfflineTextBufferHandle,
} from '../textbuffer/types';
import type {
  STTInitializeOptions,
  STTModelType,
  SttEngine,
  SttModelOptions,
  SttTranscribeResult,
  SttTranscribeOptions,
  SttRuntimeConfig,
} from './types';
import { validateSegmentationConfig } from '../segment/validation';
import type { ModelPathConfig } from '../fileio/types';
import type { FileSource } from '../fileio/types';
import { resolveModelPath } from '../utils';
import { resolveFileSourceForDetect } from '../detect';
import { resolvePublicLanguageHints } from '../model-languages';
import { ModelCategory } from '../download/types';
import {
  isDetectionSource,
  type DetectionSource,
  type DetectedModelEntry,
  type SttDetectModelResult,
} from '../types/modelDetect';
import { runOfflineAudioToTextPipeline } from '../pipeline/offlineOrchestrator';
import { addSegmentLink, createSegmentLinkMap } from '../segment';
import type { TextSegment } from '../segment/segment';
import { setOfflineTextSegments } from '../segment/runtime-state';

let sttInstanceCounter = 0;

function normalizeOfflineBufferInput(
  buffer: OfflineAudioBufferRef | OfflineBufferHandle | string
): string {
  const rawId = typeof buffer === 'string' ? buffer : buffer.bufferId;
  return resolvePipelineAudioBufferId(rawId);
}

/**
 * Detect STT model type and structure without initializing the recognizer.
 * Uses the same native file-based detection as createSTT. Stateless; no instance required.
 *
 * @param source - FileSource describing where to find the model
 * @param options - Optional preferInt8/modelType plus optional assetName and debug flag
 * @returns Object with success, detectedModels, modelType, isStreaming, optional languages, quantization, error, and isHardwareSpecificUnsupported
 * @example
 * ```typescript
 * const result = await detectSttModel({ kind: 'fs', path: '/path/to/sherpa-onnx-whisper-tiny-en' });
 * if (result.success && result.detectedModels.length > 0) {
 *   console.log('Detected type:', result.modelType, 'streaming:', result.isStreaming);
 * }
 * ```
 */
export async function detectSttModel(
  source: FileSource,
  options?: {
    preferInt8?: boolean;
    modelType?: STTModelType;
    assetName?: string;
    debug?: boolean;
  }
): Promise<SttDetectModelResult> {
  const resolved = await resolveFileSourceForDetect(source);
  const optionAssetName = options?.assetName?.trim();
  const assetName =
    optionAssetName && optionAssetName.length > 0
      ? optionAssetName
      : resolved.assetName;
  const raw = await SherpaOnnx.detectSttModel(
    resolved.modelDir,
    assetName,
    options?.modelType ?? null,
    options?.preferInt8,
    options?.debug
  );
  const err = typeof raw.error === 'string' ? raw.error.trim() : '';
  const detectedModels: DetectedModelEntry[] = (raw.detectedModels ?? []).map(
    (m) => ({
      type: m.type,
      modelDir: m.modelDir,
    })
  );
  const modelType =
    raw.modelType != null && raw.modelType !== '' ? raw.modelType : undefined;
  const detectionSources: DetectionSource[] = [];
  const rawSources = raw.detectionSources;
  if (Array.isArray(rawSources)) {
    for (const s of rawSources) {
      if (typeof s === 'string' && isDetectionSource(s)) {
        detectionSources.push(s);
      }
    }
  }
  const rawLanguageStrings =
    Array.isArray(raw.languages) && raw.languages.length > 0
      ? raw.languages.filter((x): x is string => typeof x === 'string')
      : [];
  const resolvedLanguages = resolvePublicLanguageHints({
    domain: ModelCategory.Stt,
    modelType,
    rawFromNative: rawLanguageStrings,
  });
  const quantization =
    typeof raw.quantization === 'string' && raw.quantization.length > 0
      ? raw.quantization
      : undefined;

  // isStreaming is now provided by the native online-compatibility guard.
  // Falls back to false when the native layer does not return the field.
  const isStreaming = raw.isStreaming === true;

  return {
    success: raw.success,
    isStreaming,
    ...(err.length > 0 ? { error: err } : {}),
    ...(raw.isHardwareSpecificUnsupported === true
      ? { isHardwareSpecificUnsupported: true }
      : {}),
    detectedModels,
    ...(modelType != null ? { modelType } : {}),
    ...(resolvedLanguages.length > 0 ? { languages: resolvedLanguages } : {}),
    ...(quantization != null ? { quantization } : {}),
    ...(detectionSources.length > 0 ? { detectionSources } : {}),
  };
}

/**
 * Create an STT engine instance. Call destroy() on the returned engine when done to free native resources.
 *
 * @param options - STT initialization options or model path configuration
 * @returns Promise resolving to an SttEngine instance
 * @example
 * ```typescript
 * import { createOfflineAudioBufferFromFile } from 'react-native-sherpa-onnx/audiobuffer';
 * import {
 *   createEmptyOfflineTextBuffer,
 *   getOfflineTextBufferTextSlice,
 * } from 'react-native-sherpa-onnx/textbuffer';
 * const stt = await createSTT({
 *   modelPath: { type: 'asset', path: 'models/whisper-tiny' },
 * });
 * const audio = await createOfflineAudioBufferFromFile({
 *   kind: 'fs',
 *   path: '/path/to.wav',
 * });
 * const textOut = await createEmptyOfflineTextBuffer();
 * await stt.transcribe(audio, textOut);
 * const text = await getOfflineTextBufferTextSlice(textOut, 0, 4096);
 * await stt.destroy();
 * ```
 */
export async function createSTT(
  options: STTInitializeOptions | ModelPathConfig
): Promise<SttEngine> {
  const instanceId = `stt_${++sttInstanceCounter}`;

  let modelPath: ModelPathConfig;
  let preferInt8: boolean | undefined;
  let modelType: STTModelType | undefined;
  let hotwordsFile: string | undefined;
  let hotwordsScore: number | undefined;
  let numThreads: number | undefined;
  let provider: string | undefined;
  let ruleFsts: string | undefined;
  let ruleFars: string | undefined;
  let dither: number | undefined;
  let modelOptions: SttModelOptions | undefined;
  let modelingUnit: string | undefined;
  let bpeVocab: string | undefined;

  if ('modelPath' in options) {
    modelPath = options.modelPath;
    preferInt8 = options.preferInt8;
    modelType = options.modelType;
    hotwordsFile = options.hotwordsFile;
    hotwordsScore = options.hotwordsScore;
    numThreads = options.numThreads;
    provider = options.provider;
    ruleFsts = options.ruleFsts;
    ruleFars = options.ruleFars;
    dither = options.dither;
    modelOptions = options.modelOptions;
    modelingUnit = options.modelingUnit;
    bpeVocab = options.bpeVocab;
  } else {
    modelPath = options;
    preferInt8 = undefined;
    modelType = undefined;
    hotwordsFile = undefined;
    hotwordsScore = undefined;
    numThreads = undefined;
    provider = undefined;
    ruleFsts = undefined;
    ruleFars = undefined;
    dither = undefined;
    modelOptions = undefined;
    modelingUnit = undefined;
    bpeVocab = undefined;
  }

  const debug = 'modelPath' in options ? options.debug : undefined;
  const resolvedPath = await resolveModelPath(modelPath);

  const result = await SherpaOnnx.initializeStt(
    instanceId,
    resolvedPath,
    preferInt8,
    modelType,
    debug,
    hotwordsFile,
    hotwordsScore,
    numThreads,
    provider,
    ruleFsts,
    ruleFars,
    dither,
    modelOptions,
    modelingUnit,
    bpeVocab
  );

  if (!result.success) {
    const nativeError =
      typeof result.error === 'string' ? result.error.trim() : '';
    const detected = JSON.stringify(result.detectedModels ?? []);
    throw new Error(
      nativeError.length > 0
        ? `STT initialization failed: ${nativeError}`
        : `STT initialization failed: ${detected}`
    );
  }

  let destroyed = false;

  const guard = () => {
    if (destroyed) {
      throw new Error(
        `STT instance ${instanceId} has been destroyed; cannot call methods on it.`
      );
    }
  };

  const engine: SttEngine = {
    get instanceId() {
      return instanceId;
    },

    async transcribe(
      buffer: OfflineAudioBufferRef | OfflineBufferHandle | string,
      textOut: OfflineTextBufferRef | OfflineTextBufferHandle | string,
      options?: SttTranscribeOptions
    ): Promise<SttTranscribeResult> {
      guard();
      const startedAtMs = Date.now();
      const bufferId = normalizeOfflineBufferInput(buffer);
      const textOutBufferId = resolvePipelineTextBufferId(
        typeof textOut === 'string' ? textOut : textOut.bufferId
      );

      const segmentation = validateSegmentationConfig({
        mode: options?.segmentation?.mode,
        policy: options?.segmentation?.policy,
        featureName: 'offline STT',
        domain: 'speech',
        supportsManual: false,
        defaultPolicy: {
          evaluator: 'speech_energy_silence',
          silenceThresholdMs: 500,
          energyThresholdDb: -40,
          minSegmentMs: 1000,
          maxSegmentMs: 30000,
          hangoverMs: 300,
        },
      });

      const segmentationEnabled = segmentation.mode !== 'off';

      if (!segmentationEnabled) {
        await SherpaOnnx.transcribe(instanceId, bufferId, textOutBufferId);
        return {
          status: 'complete',
          totalSegments: 1,
          completedSegments: 1,
          skippedSegments: [],
          processingTimeMs: Date.now() - startedAtMs,
          linkMap: options?.linkMap,
        };
      }

      const orchestrated = await runOfflineAudioToTextPipeline(
        bufferId,
        async (segIn, segOut) => {
          await SherpaOnnx.transcribe(
            instanceId,
            segIn.bufferId,
            segOut.bufferId
          );
        },
        {
          segmentation: {
            mode: segmentation.mode,
            policy: segmentation.policy,
          },
          errorRecovery: options?.errorRecovery,
          maxRetriesPerSegment: options?.maxRetriesPerSegment,
          retryExhaustedFallback: options?.retryExhaustedFallback,
          abortSignal: options?.abortSignal,
          onProgress: options?.onProgress,
          textSkipPlaceholder: options?.textSkipPlaceholder,
          linkMap: options?.linkMap,
        }
      );

      if (orchestrated.status === 'failed') {
        const message =
          orchestrated.failedSegment?.error ??
          'STT segmented transcription failed';
        throw new Error(message);
      }

      let linkMap = options?.linkMap;
      if (!linkMap) {
        linkMap = await createSegmentLinkMap({
          audioBufferId: bufferId,
          textBufferId: textOutBufferId,
        });
      }

      const outputBuffer = orchestrated.outputBuffer;
      let finalText = '';
      if (outputBuffer) {
        try {
          const outInfo = await getPipelineTextBufferInfo(
            outputBuffer.bufferId
          );
          if (outInfo.kind === 'offlineTextBuffer' && outInfo.utf16Length > 0) {
            finalText = await getOfflineTextBufferTextSlice(
              outputBuffer.bufferId,
              0,
              outInfo.utf16Length
            );
          }

          await SherpaOnnx.populateOfflineTextBufferIfEmpty(
            textOutBufferId,
            finalText,
            {}
          );
        } finally {
          await releasePipelineTextBuffer(outputBuffer.bufferId);
        }
      } else {
        await SherpaOnnx.populateOfflineTextBufferIfEmpty(
          textOutBufferId,
          '',
          {}
        );
      }

      let runningOffset = 0;
      const textSegments: TextSegment[] = orchestrated.segmentMappings.map(
        (mapping, index) => {
          const segmentText = mapping.text;
          const startOffset = runningOffset;
          const endOffset = startOffset + segmentText.length;
          runningOffset = endOffset;
          return {
            segmentId: `txtseg_${textOutBufferId}_${index}`,
            domain: 'text',
            startOffset,
            endOffset,
            reason: 'endpoint',
            source: 'segmentation_engine',
            createdAtMs: Date.now(),
            segmentIndex: index,
            text: segmentText,
            utf16Length: segmentText.length,
          };
        }
      );
      setOfflineTextSegments(textOutBufferId, textSegments);

      for (let i = 0; i < textSegments.length; i += 1) {
        const textSegment = textSegments[i]!;
        const mapping = orchestrated.segmentMappings[i];
        if (!mapping) continue;
        await addSegmentLink(linkMap, {
          textSegmentId: textSegment.segmentId,
          speechSegmentId: mapping.speechSegmentId,
          linkType: 'stt_produced',
        });
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
        linkMap,
      };
    },

    async setConfig(config: SttRuntimeConfig): Promise<void> {
      guard();
      const map: Record<string, string | number> = {};
      if (config.decodingMethod != null)
        map.decodingMethod = config.decodingMethod;
      if (config.maxActivePaths != null)
        map.maxActivePaths = config.maxActivePaths;
      if (config.hotwordsFile != null) map.hotwordsFile = config.hotwordsFile;
      if (config.hotwordsScore != null)
        map.hotwordsScore = config.hotwordsScore;
      if (config.blankPenalty != null) map.blankPenalty = config.blankPenalty;
      if (config.ruleFsts != null) map.ruleFsts = config.ruleFsts;
      if (config.ruleFars != null) map.ruleFars = config.ruleFars;
      return SherpaOnnx.setSttConfig(instanceId, map);
    },

    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      await SherpaOnnx.unloadStt(instanceId);
    },
  };

  return engine;
}

// Streaming (online) STT
export { createStreamingSTT, createLiveSTT } from './streaming';
export type {
  OnlineSTTModelType,
  LiveSttEngine,
  StreamingSttInitOptions,
  SttPipelineHandle,
  SttPipelineOptions,
  EndpointConfig,
  EndpointRule,
} from './streamingTypes';
export { ONLINE_STT_MODEL_TYPES } from './streamingTypes';

// Export types and runtime type list
export type {
  STTInitializeOptions,
  STTModelType,
  SttModelOptions,
  SttQwen3AsrModelOptions,
  SttCohereTranscribeModelOptions,
  SttTranscribeOptions,
  SttTranscribeResult,
  SttSegmentationConfig,
  SttRuntimeConfig,
  SttEngine,
  SttInitResult,
  SttErrorCodeValue,
} from './types';
export type { SttDetectModelResult } from '../types/modelDetect';
export {
  STT_MODEL_TYPES,
  STT_HOTWORDS_MODEL_TYPES,
  sttSupportsHotwords,
  SttErrorCode,
} from './types';
