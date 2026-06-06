import SherpaOnnx from '../NativeSherpaOnnx';
import { resolvePipelineAudioBufferId } from '../audiobuffer';
import {
  getOfflineTextBufferTextSlice,
  getPipelineTextBufferInfo,
  releasePipelineTextBuffer,
  resolvePipelineTextBufferId,
  subscribeLiveTextBufferEvents,
} from '../textbuffer';
import type {
  OfflineAudioBufferRef,
  OfflineBufferHandle,
  LiveAudioBufferIdSource,
  LiveAudioBufferRef,
} from '../audiobuffer/types';
import type { PipelineAudioBufferIdSource } from '../audiobuffer/types';
import type {
  OfflineTextBufferRef,
  OfflineTextBufferHandle,
  LiveTextBufferIdSource,
  LiveTextBufferRef,
} from '../textbuffer/types';
import type { PipelineTextBufferIdSource } from '../textbuffer/types';
import type {
  STTInitializeOptions,
  STTModelType,
  SttEngine,
  SttLivePipelineOptions,
  SttTranscribeResult,
  SttTranscribeOptions,
  SttRuntimeConfig,
} from './types';
import { validateSegmentationConfig } from '../segment/validation';
import { validateLiveOfflinePipelineOptions } from '../livePipeline';
import {
  attachSegmentationEngine,
  detachSegmentationEngine,
  getSegmentationEngineInfo,
} from '../segment';
import { createStreamingPipelineCompletionPromise } from '../audiobuffer/streamingPipelineCompletion';
import type { SttPipelineHandle } from './streamingTypes';
import type { FileSource } from '../fileio/types';
import { resolveFileSourceForDetect } from '../detect/resolveModelInput';
import { resolvePublicLanguageHints } from '../model-languages';
import { readNonEmptyDetectPathsMap } from '../detect/detectModelOutput';
import { ModelCategory } from '../download/types';
import {
  isDetectionSource,
  type DetectionSource,
  type DetectedModelEntry,
  type SttDetectModelResult,
} from '../types/modelDetect';
import { buildSttInitBridgeOptions } from './sttNativeBridge';
import { runOfflineAudioToTextPipeline } from '../pipeline/offlineOrchestrator';
import { addSegmentLink, createSegmentLinkMap } from '../segment';
import type { TextSegment } from '../segment/segment';
import { setOfflineTextSegments } from '../segment/runtime-state';

let sttInstanceCounter = 0;

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

function createSttPipelineHandle(
  instanceId: string,
  pipelineId: string,
  attachedEngineId?: string
): SttPipelineHandle {
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

async function transcribeLiveOverload(
  instanceId: string,
  audioIn: LiveAudioBufferIdSource,
  textOut: LiveTextBufferIdSource,
  options: SttLivePipelineOptions
): Promise<SttPipelineHandle> {
  const { policy } = validateLiveOfflinePipelineOptions({
    featureName: 'live offline STT',
    domain: 'speech',
    segmentation: options.segmentation,
  });

  const audioInId = resolvePipelineAudioBufferId(
    audioIn as PipelineAudioBufferIdSource
  );
  const textOutId = resolvePipelineTextBufferId(
    textOut as PipelineTextBufferIdSource
  );

  const attached = await attachSegmentationEngine(
    audioIn as PipelineAudioBufferIdSource,
    { policy }
  );
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
      'STT_TRANSCRIBE_FAILED: segmentation engine did not produce a segment buffer for speech domain'
    );
  }

  let pipelineId: string;
  try {
    const result = await SherpaOnnx.startSttOfflineLivePipeline(
      instanceId,
      audioInId,
      textOutId,
      {
        attachedSegmentationEngineId: attached.engineId,
        segmentLiveBufferId,
      }
    );
    pipelineId = result.pipelineId;
  } catch (err) {
    await detachSegmentationEngine(attached.engineId, {
      flushFinal: false,
    }).catch(() => undefined);
    throw err;
  }

  const handle = createSttPipelineHandle(
    instanceId,
    pipelineId,
    attached.engineId
  );

  if (options.onSegment) {
    const cb = options.onSegment;
    const unsub = subscribeLiveTextBufferEvents(textOut, {
      onSegment: (event) => cb(event.segment as TextSegment),
    });
    handle.completed.then(unsub, unsub);
  }

  return handle;
}

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

  const isStreaming = raw.isStreaming === true;
  const paths = readNonEmptyDetectPathsMap(raw.paths);

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
    ...(paths != null ? { paths } : {}),
  };
}

/**
 * Create an STT engine instance. Call destroy() on the returned engine when done to free native resources.
 *
 * @param options - STT initialization options
 * @returns Promise resolving to an SttEngine instance
 * @example
 * ```typescript
 * import { createOfflineAudioBufferFromFile } from 'react-native-sherpa-onnx/audiobuffer';
 * import {
 *   createEmptyOfflineTextBuffer,
 *   getOfflineTextBufferTextSlice,
 * } from 'react-native-sherpa-onnx/textbuffer';
 * const stt = await createSTT({
 *   modelSource: { kind: 'fs', path: '/path/to/model-dir' },
 *   modelType: 'auto',
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
  options: STTInitializeOptions
): Promise<SttEngine> {
  const instanceId = `stt_${++sttInstanceCounter}`;
  const bridgeOptions = await buildSttInitBridgeOptions(options);

  const result = await SherpaOnnx.initializeStt(instanceId, bridgeOptions);

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

  const engine = {
    get instanceId() {
      return instanceId;
    },

    async transcribe(
      buffer:
        | OfflineAudioBufferRef
        | OfflineBufferHandle
        | LiveAudioBufferIdSource
        | string,
      textOut:
        | OfflineTextBufferRef
        | OfflineTextBufferHandle
        | LiveTextBufferIdSource
        | string,
      transcribeOptions?: SttTranscribeOptions | SttLivePipelineOptions
    ): Promise<SttTranscribeResult | SttPipelineHandle> {
      guard();

      const audioIsLive = isLiveAudioSource(buffer);
      const textIsLive = isLiveTextSource(textOut);

      if (audioIsLive || textIsLive) {
        if (!(audioIsLive && textIsLive)) {
          throw new Error(
            'STT_INVALID_ARGUMENT: transcribe() overload mismatch. Use (OfflineAudio, OfflineText, options?) or (LiveAudio, LiveText, options).'
          );
        }
        return transcribeLiveOverload(
          instanceId,
          buffer,
          textOut,
          transcribeOptions as SttLivePipelineOptions
        );
      }

      // Batch path: narrow options to SttTranscribeOptions
      const batchOptions = transcribeOptions as
        | SttTranscribeOptions
        | undefined;
      const startedAtMs = Date.now();
      const bufferId = normalizeOfflineBufferInput(
        buffer as OfflineAudioBufferRef | OfflineBufferHandle | string
      );
      const textOutBufferId = resolvePipelineTextBufferId(
        typeof textOut === 'string'
          ? textOut
          : String((textOut as OfflineTextBufferRef).bufferId ?? textOut)
      );

      const segmentation = validateSegmentationConfig({
        mode: batchOptions?.segmentation?.mode,
        policy: batchOptions?.segmentation?.policy,
        featureName: 'offline STT',
        domain: 'speech',
        supportsManual: false,
        defaultPolicy: {
          evaluator: 'speech_energy_silence',
          silenceThresholdMs: 500,
          energyThresholdDb: -40,
          minSegmentMs: 1000,
          maxSegmentMs: 120000,
          hangoverMs: 300,
        },
      });

      const segmentationEnabled = segmentation.mode !== 'off';

      if (!segmentationEnabled) {
        if (batchOptions?.onProgress) {
          batchOptions.onProgress({
            currentSegment: 0,
            totalSegments: 1,
            fraction: 0,
            elapsedMs: 0,
            currentSegmentDurationMs: 0,
          });
        }
        await SherpaOnnx.transcribe(instanceId, bufferId, textOutBufferId);
        if (batchOptions?.onProgress) {
          batchOptions.onProgress({
            currentSegment: 0,
            totalSegments: 1,
            fraction: 1,
            elapsedMs: Date.now() - startedAtMs,
            currentSegmentDurationMs: Date.now() - startedAtMs,
          });
        }
        return {
          status: 'complete',
          totalSegments: 1,
          completedSegments: 1,
          skippedSegments: [],
          processingTimeMs: Date.now() - startedAtMs,
          linkMap: batchOptions?.linkMap,
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
          errorRecovery: batchOptions?.errorRecovery,
          maxRetriesPerSegment: batchOptions?.maxRetriesPerSegment,
          retryExhaustedFallback: batchOptions?.retryExhaustedFallback,
          abortSignal: batchOptions?.abortSignal,
          onProgress: batchOptions?.onProgress,
          textSkipPlaceholder: batchOptions?.textSkipPlaceholder,
          linkMap: batchOptions?.linkMap,
        }
      );

      if (orchestrated.status === 'failed') {
        const message =
          orchestrated.failedSegment?.error ??
          'STT segmented transcription failed';
        throw new Error(message);
      }

      let linkMap = batchOptions?.linkMap;
      if (!linkMap?.linkMapId) {
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

  return engine as unknown as SttEngine;
}

// Streaming (online) STT
export { createStreamingSTT, createLiveSTT } from './streaming';
export type {
  OnlineSTTModelType,
  LiveSttEngine,
  StreamingSttInitOptions,
  StreamingSttAutoInitOptions,
  StreamingSttCustomInitOptions,
  SttPipelineHandle,
  SttPipelineOptions,
  EndpointConfig,
  EndpointRule,
} from './streamingTypes';
export { ONLINE_STT_MODEL_TYPES } from './streamingTypes';

// Export types and runtime type list
export type {
  STTInitializeOptions,
  STTAutoInitializeOptions,
  STTCustomInitializeOptions,
  STTConcreteModelType,
  STTInitializeOptionsBase,
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
export type {
  SttCustomConfig,
  SttCustomConfigByModelType,
  SttCustomPathKey,
  SttTransducerCustomConfig,
  SttWhisperCustomConfig,
} from './customConfig';
export {
  assertSttCustomConfig,
  resolveSttCustomConfigPaths,
} from './customConfig';
export type {
  StreamingSttCustomConfig,
  StreamingSttCustomConfigByModelType,
  StreamingSttCustomPathKey,
  StreamingTransducerCustomConfig,
  StreamingParaformerCustomConfig,
  StreamingSingleModelCustomConfig,
} from './streamingCustomConfig';
export {
  assertStreamingSttCustomConfig,
  resolveStreamingSttCustomConfigPaths,
} from './streamingCustomConfig';
export type { SttDetectModelResult } from '../types/modelDetect';
export {
  STT_MODEL_TYPES,
  STT_HOTWORDS_MODEL_TYPES,
  sttSupportsHotwords,
  SttErrorCode,
} from './types';
