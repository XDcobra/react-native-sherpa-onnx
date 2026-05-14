import { NativeEventEmitter } from 'react-native';
import SherpaOnnx from '../NativeSherpaOnnx';
import {
  resolveFileSourceForDetect,
  resolveFileSourceForModelInit,
} from '../detect';
import { resolvePublicLanguageHints } from '../model-languages';
import { ModelCategory } from '../download/types';
import {
  createOfflineAudioBufferFromSamples,
  getOfflineAudioBufferSamplesSlice,
  releasePipelineAudioBuffer,
  resolvePipelineAudioBufferId,
} from '../audiobuffer';
import { getSegments, segmentOfflineBuffer } from '../segment';
import type { SegmentationPolicy } from '../segment/engine-types';
import type { SpeechSegment } from '../segment/segment';
import {
  appendLiveSegment,
  createEmptyOfflineSegmentBuffer,
  createLiveSegmentBuffer,
  finalizeLiveSegmentBuffer,
  getOfflineSegmentBufferSegments,
  populateOfflineSegmentBufferIfEmpty,
  releasePipelineSegmentBuffer,
  resolvePipelineSegmentBufferId,
} from '../segmentbuffer';
import { validateSegmentationConfig } from '../segment/validation';
import type {
  DetectedModelEntry,
  DetectionSource,
  OrchestrationProgress,
  VADDetectResult,
  VADEngine,
  VADInitializeOptions,
  VADLiveProcessInput,
  VADOfflineProcessInput,
  VADOfflineResult,
  VADPipelineHandle,
  VADPipelineStatus,
  VADModelType,
  VADSummary,
} from './types';
import type { FileSource } from '../fileio/types';
import { isDetectionSource } from './types';

let vadInstanceCounter = 0;
const SEGMENT_PAGE_SIZE = 4096;

type OfflineVadNativeSummary = {
  chunksProcessed: number;
  unitsRead: number;
  unitsWritten: number;
  segmentCount: number;
  speechDurationMs: number;
};

interface VadProgressSession {
  emitStep(
    currentSegment: number,
    totalSegments: number,
    currentSegmentDurationMs: number
  ): void;
}

function isAbortRequested(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function createVadProgressSession(
  onProgress: ((progress: OrchestrationProgress) => void) | undefined,
  startedAtMs: number = Date.now()
): VadProgressSession {
  return {
    emitStep(
      currentSegment: number,
      totalSegments: number,
      currentSegmentDurationMs: number
    ): void {
      if (!onProgress) {
        return;
      }

      const fraction = totalSegments > 0 ? currentSegment / totalSegments : 1;
      onProgress({
        currentSegment,
        totalSegments,
        fraction,
        currentSegmentDurationMs,
        elapsedMs: Date.now() - startedAtMs,
      });
    },
  };
}

async function collectSpeechSegmentsForOfflineAudio(
  audioInBufferId: string,
  segmentationPolicy: SegmentationPolicy
): Promise<SpeechSegment[]> {
  const segmentRef = await segmentOfflineBuffer(
    audioInBufferId,
    segmentationPolicy
  );

  const speechSegments: SpeechSegment[] = [];
  let startIndex = 0;

  while (true) {
    const page = await getSegments(segmentRef, startIndex, SEGMENT_PAGE_SIZE);
    if (page.length === 0) {
      break;
    }

    for (const segment of page) {
      if (segment.domain === 'speech') {
        speechSegments.push(segment);
      }
    }

    startIndex += page.length;
    if (page.length < SEGMENT_PAGE_SIZE) {
      break;
    }
  }

  return speechSegments;
}

function accumulateVadSummary(
  aggregate: VADSummary,
  chunk: OfflineVadNativeSummary
): void {
  aggregate.chunksProcessed += chunk.chunksProcessed;
  aggregate.unitsRead += chunk.unitsRead;
  aggregate.unitsWritten += chunk.unitsWritten;
  aggregate.segmentCount += chunk.segmentCount;
  aggregate.speechDurationMs += chunk.speechDurationMs;
}

function toStatus(raw: any): VADPipelineStatus {
  return {
    pipelineId: String(raw?.pipelineId ?? ''),
    isRunning: raw?.isRunning === true,
    isFlushing: raw?.isFlushing === true,
    queueDepth:
      typeof raw?.queueDepth === 'number' ? Math.trunc(raw.queueDepth) : 0,
    chunksProcessed:
      typeof raw?.chunksProcessed === 'number'
        ? Math.trunc(raw.chunksProcessed)
        : 0,
    unitsRead:
      typeof raw?.unitsRead === 'number' ? Math.trunc(raw.unitsRead) : 0,
    unitsWritten:
      typeof raw?.unitsWritten === 'number' ? Math.trunc(raw.unitsWritten) : 0,
    error: typeof raw?.error === 'string' ? raw.error : null,
  };
}

function toSummary(raw: any): VADSummary {
  return {
    chunksProcessed:
      typeof raw?.chunksProcessed === 'number'
        ? Math.trunc(raw.chunksProcessed)
        : 0,
    unitsRead:
      typeof raw?.unitsRead === 'number' ? Math.trunc(raw.unitsRead) : 0,
    unitsWritten:
      typeof raw?.unitsWritten === 'number' ? Math.trunc(raw.unitsWritten) : 0,
    segmentCount:
      typeof raw?.segmentCount === 'number' ? Math.trunc(raw.segmentCount) : 0,
    speechDurationMs:
      typeof raw?.speechDurationMs === 'number'
        ? Math.trunc(raw.speechDurationMs)
        : 0,
  };
}

function resolveRuntimeTuningOptions(
  runtimeOptions: VADInitializeOptions['runtimeOptions'],
  modelType: VADModelType
) {
  if (!runtimeOptions) {
    return undefined;
  }
  if (modelType === 'silero_vad') {
    if ('sileroVad' in runtimeOptions) {
      return runtimeOptions.sileroVad;
    }
    throw Object.assign(
      new Error(
        'VAD runtime options mismatch: expected sileroVad options for silero_vad model'
      ),
      { code: 'VAD_INVALID_OPTIONS' }
    );
  }
  if ('tenVad' in runtimeOptions) {
    return runtimeOptions.tenVad;
  }
  throw Object.assign(
    new Error(
      'VAD runtime options mismatch: expected tenVad options for ten_vad model'
    ),
    { code: 'VAD_INVALID_OPTIONS' }
  );
}

export async function detectVadModel(
  source: FileSource,
  options?: {
    modelType?: VADInitializeOptions['modelType'];
    assetName?: string;
  }
): Promise<VADDetectResult> {
  const resolved = await resolveFileSourceForDetect(source);
  const optionAssetName = options?.assetName?.trim();
  const assetName =
    optionAssetName && optionAssetName.length > 0
      ? optionAssetName
      : resolved.assetName;
  const raw = await SherpaOnnx.detectVadModel(
    resolved.modelDir,
    assetName,
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
  const rawLanguageStrings =
    Array.isArray(raw.languages) && raw.languages.length > 0
      ? raw.languages.filter((x): x is string => typeof x === 'string')
      : [];
  const resolvedLanguages = resolvePublicLanguageHints({
    domain: ModelCategory.Vad,
    modelType: raw.modelType,
    rawFromNative: rawLanguageStrings,
  });
  const quantization =
    typeof raw.quantization === 'string' && raw.quantization.length > 0
      ? raw.quantization
      : undefined;
  const modelPath =
    raw.paths != null &&
    typeof raw.paths === 'object' &&
    typeof raw.paths.model === 'string' &&
    raw.paths.model.length > 0
      ? raw.paths.model
      : undefined;
  return {
    success: raw.success,
    isStreaming: raw.isStreaming === true,
    ...(err.length > 0 ? { error: err } : {}),
    detectedModels,
    ...(raw.modelType != null && raw.modelType !== ''
      ? { modelType: raw.modelType }
      : {}),
    ...(modelPath != null ? { paths: { model: modelPath } } : {}),
    ...(resolvedLanguages.length > 0 ? { languages: resolvedLanguages } : {}),
    ...(quantization != null ? { quantization } : {}),
    ...(detectionSources.length > 0 ? { detectionSources } : {}),
  };
}

export async function createStreamingVAD(
  options: VADInitializeOptions
): Promise<VADEngine> {
  const instanceId = `vad_${++vadInstanceCounter}`;
  const modelDir = await resolveFileSourceForModelInit(options.modelSource);
  let resolvedModelType: 'auto' | VADModelType = options.modelType ?? 'auto';
  if (resolvedModelType === 'auto') {
    const detect = await SherpaOnnx.detectVadModel(modelDir, null, 'auto');
    if (
      !detect.success ||
      detect.modelType == null ||
      detect.modelType === ''
    ) {
      const reason =
        (typeof detect.error === 'string' ? detect.error.trim() : '') ||
        'Failed to detect VAD model type in auto mode';
      throw Object.assign(new Error(reason), {
        code: 'VAD_MODEL_INIT_FAILED',
      });
    }
    resolvedModelType = detect.modelType as VADModelType;
  }
  const runtimeTuning = resolveRuntimeTuningOptions(
    options.runtimeOptions,
    resolvedModelType
  );
  await SherpaOnnx.initializeVad(instanceId, {
    modelDir,
    modelType: resolvedModelType,
    sampleRate: options.sampleRate,
    silenceDurationMs: runtimeTuning?.minSilenceDurationMs,
    speechDurationMs: runtimeTuning?.minSpeechDurationMs,
    maxSpeechDurationS:
      typeof runtimeTuning?.maxSpeechDurationMs === 'number'
        ? runtimeTuning.maxSpeechDurationMs / 1000
        : undefined,
    minSpeechDurationMs: runtimeTuning?.minSpeechDurationMs,
    threshold: runtimeTuning?.scoreThreshold,
    windowSize: runtimeTuning?.windowSize,
    provider: options.provider,
    numThreads: options.numThreads,
    debug: options.debug,
  });

  let destroyed = false;
  let activePipelineId: string | null = null;

  const ensureUsable = () => {
    if (destroyed) {
      throw new Error(`VAD engine ${instanceId} is destroyed`);
    }
  };

  const engine: VADEngine = {
    get instanceId() {
      return instanceId;
    },
    async process(
      input: VADLiveProcessInput | VADOfflineProcessInput
    ): Promise<VADPipelineHandle | VADOfflineResult> {
      ensureUsable();
      const audioInBufferId = resolvePipelineAudioBufferId(input.audioIn);
      const segmentOutBufferId = resolvePipelineSegmentBufferId(
        input.segmentOut
      );

      if (audioInBufferId.startsWith('live_')) {
        if (activePipelineId != null) {
          const status = toStatus(
            await SherpaOnnx.getVadPipelineStatus(activePipelineId)
          );
          if (status.isRunning) {
            throw Object.assign(
              new Error(`VAD pipeline already running for ${instanceId}`),
              { code: 'VAD_INVALID_STATE' }
            );
          }
          activePipelineId = null;
        }
        const liveOptions = (input as VADLiveProcessInput).options ?? {};
        const started = await SherpaOnnx.startVadPipeline(
          instanceId,
          audioInBufferId,
          segmentOutBufferId,
          liveOptions
        );
        const pipelineId = started.pipelineId;
        activePipelineId = pipelineId;

        const emitter = new NativeEventEmitter();
        const speechStateMin = Math.max(
          0,
          typeof liveOptions.speechStateEventMinIntervalMs === 'number'
            ? Math.trunc(liveOptions.speechStateEventMinIntervalMs)
            : 0
        );
        let lastSpeechEmit = 0;
        let removeVadEvent: (() => void) | null = null;

        let onSpeechStateChanged:
          | VADPipelineHandle['onSpeechStateChanged']
          | undefined;

        const completed = new Promise<VADSummary>((resolve, reject) => {
          const sub = emitter.addListener(
            'vadEvent',
            (raw: {
              type?: string;
              instanceId?: string;
              pipelineId?: string;
              ts?: number;
              isSpeechDetected?: boolean;
              error?: string;
              summary?: any;
            }) => {
              if (!raw || raw.instanceId !== instanceId) return;
              if (raw.pipelineId !== pipelineId) return;
              if (raw.type === 'pipeline.completed') {
                if (removeVadEvent) {
                  removeVadEvent();
                } else {
                  sub.remove();
                }
                activePipelineId = null;
                if (raw.summary && typeof raw.summary === 'object') {
                  resolve(toSummary(raw.summary));
                } else {
                  resolve(toSummary(raw));
                }
                return;
              }
              if (raw.type === 'pipeline.error') {
                if (removeVadEvent) {
                  removeVadEvent();
                } else {
                  sub.remove();
                }
                activePipelineId = null;
                reject(
                  Object.assign(
                    new Error(
                      typeof raw.error === 'string'
                        ? raw.error
                        : 'Unknown VAD pipeline error'
                    ),
                    { code: 'VAD_INTERNAL_ERROR' }
                  )
                );
                return;
              }
              if (raw.type === 'vad.stateChanged' && onSpeechStateChanged) {
                const now = Date.now();
                if (
                  speechStateMin > 0 &&
                  now - lastSpeechEmit < speechStateMin
                ) {
                  return;
                }
                lastSpeechEmit = now;
                onSpeechStateChanged({
                  isSpeechDetected: raw.isSpeechDetected === true,
                  pipelineId,
                  ts: typeof raw.ts === 'number' ? raw.ts : now,
                });
              }
            }
          );
          removeVadEvent = () => {
            sub.remove();
            removeVadEvent = null;
          };
        });

        const handle: VADPipelineHandle = {
          instanceId,
          pipelineId,
          get onSpeechStateChanged() {
            return onSpeechStateChanged;
          },
          set onSpeechStateChanged(
            h: VADPipelineHandle['onSpeechStateChanged'] | undefined
          ) {
            onSpeechStateChanged = h;
          },
          completed,
          async stop() {
            if (removeVadEvent) removeVadEvent();
            // Native stop is synchronous wrt worker teardown.
            await SherpaOnnx.stopVadPipeline(pipelineId);
            if (activePipelineId === pipelineId) {
              activePipelineId = null;
            }
          },
          async flush() {
            await SherpaOnnx.flushVad(pipelineId);
          },
          async reset() {
            await SherpaOnnx.resetVad(pipelineId);
          },
          async getStatus() {
            return toStatus(await SherpaOnnx.getVadPipelineStatus(pipelineId));
          },
        };
        return handle;
      }

      const offlineOptions = (input as VADOfflineProcessInput).options ?? {};
      if (
        offlineOptions.onProgress != null &&
        typeof offlineOptions.onProgress !== 'function'
      ) {
        throw Object.assign(
          new Error(
            'VAD_INVALID_OPTIONS: options.onProgress must be a function'
          ),
          { code: 'VAD_INVALID_OPTIONS' }
        );
      }

      const segmentation = validateSegmentationConfig({
        mode: offlineOptions.segmentation?.mode,
        policy: offlineOptions.segmentation?.policy,
        featureName: 'offline VAD',
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

      const nativeOfflineOptions =
        typeof offlineOptions.sourceTag === 'string' &&
        offlineOptions.sourceTag.trim().length > 0
          ? { sourceTag: offlineOptions.sourceTag }
          : {};

      if (segmentation.mode !== 'off') {
        const segmentationPolicy = segmentation.policy;
        if (!segmentationPolicy) {
          throw Object.assign(
            new Error(
              'SEGMENTATION_POLICY_INVALID: offline VAD requires segmentation.policy when segmentation.mode=auto'
            ),
            { code: 'SEGMENTATION_POLICY_INVALID' }
          );
        }
        if (isAbortRequested(offlineOptions.abortSignal)) {
          throw Object.assign(
            new Error(
              'VAD_ABORTED: offline VAD segmentation run was aborted before processing'
            ),
            { code: 'VAD_ABORTED' }
          );
        }
        const speechSegments = await collectSpeechSegmentsForOfflineAudio(
          audioInBufferId,
          segmentationPolicy
        );
        const progressSession = createVadProgressSession(
          offlineOptions.onProgress
        );
        const totalSegments = speechSegments.length;

        const aggregated: VADSummary = {
          chunksProcessed: 0,
          unitsRead: 0,
          unitsWritten: 0,
          segmentCount: 0,
          speechDurationMs: 0,
        };

        const outputIsOffline = segmentOutBufferId.startsWith('seg_off_');
        let stagingLiveBufferId: string | undefined;

        const ensureLiveMergeTarget = async (): Promise<string> => {
          if (!outputIsOffline) {
            return segmentOutBufferId;
          }
          if (stagingLiveBufferId != null) {
            return stagingLiveBufferId;
          }
          const staging = await createLiveSegmentBuffer({
            sourceAudioBufferId: audioInBufferId,
            spooling: { mode: 'on' },
          });
          stagingLiveBufferId = staging.bufferId;
          return stagingLiveBufferId;
        };

        try {
          for (const [
            segmentIndex,
            speechSegment,
          ] of speechSegments.entries()) {
            if (isAbortRequested(offlineOptions.abortSignal)) {
              throw Object.assign(
                new Error(
                  `VAD_ABORTED: offline VAD segmentation run aborted before segment ${segmentIndex}`
                ),
                { code: 'VAD_ABORTED' }
              );
            }
            const startSample = Math.max(
              0,
              Math.trunc(speechSegment.startOffset)
            );
            const endSample = Math.max(
              startSample,
              Math.trunc(speechSegment.endOffset)
            );
            const frameCount = endSample - startSample;
            const sampleRate = Math.max(
              1,
              Math.trunc(speechSegment.sampleRate)
            );
            let currentSegmentDurationMs = 0;
            if (
              typeof speechSegment.durationMs === 'number' &&
              Number.isFinite(speechSegment.durationMs)
            ) {
              currentSegmentDurationMs = speechSegment.durationMs;
            } else if (frameCount > 0) {
              currentSegmentDurationMs = (frameCount / sampleRate) * 1000;
            }
            progressSession.emitStep(
              segmentIndex,
              totalSegments,
              currentSegmentDurationMs
            );

            if (frameCount <= 0) {
              continue;
            }

            const sliceSamples = getOfflineAudioBufferSamplesSlice(
              audioInBufferId,
              startSample,
              frameCount
            );

            if (sliceSamples.length <= 0) {
              continue;
            }
            const sliceAudio = createOfflineAudioBufferFromSamples(
              sliceSamples,
              sampleRate,
              { targetSampleRateHz: 0 }
            );

            const sliceSegmentOut = await createEmptyOfflineSegmentBuffer({
              sourceAudioBufferId: sliceAudio.bufferId,
            });

            try {
              const raw = (await SherpaOnnx.runVadOffline(
                instanceId,
                sliceAudio.bufferId,
                sliceSegmentOut.bufferId,
                nativeOfflineOptions
              )) as OfflineVadNativeSummary;

              accumulateVadSummary(aggregated, raw);

              if (raw.segmentCount <= 0) {
                continue;
              }

              const mergeTargetId = await ensureLiveMergeTarget();
              let offset = 0;

              while (offset < raw.segmentCount) {
                const chunk = await getOfflineSegmentBufferSegments(
                  sliceSegmentOut.bufferId,
                  offset,
                  Math.min(SEGMENT_PAGE_SIZE, raw.segmentCount - offset)
                );

                if (chunk.length === 0) {
                  break;
                }

                offset += chunk.length;

                for (const segment of chunk) {
                  if (segment.kind !== 'speech') {
                    continue;
                  }

                  await appendLiveSegment(mergeTargetId, {
                    kind: 'speech',
                    sourceAudioBufferId: audioInBufferId,
                    startSample: startSample + segment.startSample,
                    endSample: startSample + segment.endSample,
                    sampleRate: segment.sampleRate,
                    durationMs: segment.durationMs,
                    confidence: segment.confidence,
                    ...(segment.payload != null
                      ? { payload: segment.payload }
                      : {}),
                  });
                }
              }
            } finally {
              await releasePipelineSegmentBuffer(
                sliceSegmentOut.bufferId
              ).catch(() => undefined);
              await releasePipelineAudioBuffer(sliceAudio.bufferId).catch(
                () => undefined
              );
            }
          }

          if (outputIsOffline && stagingLiveBufferId != null) {
            await finalizeLiveSegmentBuffer(stagingLiveBufferId);
            await populateOfflineSegmentBufferIfEmpty(
              segmentOutBufferId,
              stagingLiveBufferId
            );
          }

          return {
            summary: aggregated,
            segmentBufferId: segmentOutBufferId,
          };
        } finally {
          if (stagingLiveBufferId != null) {
            await releasePipelineSegmentBuffer(stagingLiveBufferId).catch(
              () => undefined
            );
          }
        }
      }

      const result = await SherpaOnnx.runVadOffline(
        instanceId,
        audioInBufferId,
        segmentOutBufferId,
        nativeOfflineOptions
      );
      return {
        summary: toSummary(result),
        segmentBufferId: segmentOutBufferId,
      };
    },
    async isSpeechDetected(): Promise<boolean> {
      ensureUsable();
      return SherpaOnnx.isVadSpeechDetected(instanceId);
    },
    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      if (activePipelineId != null) {
        try {
          // Ignore already-removed pipeline races during destroy.
          await SherpaOnnx.stopVadPipeline(activePipelineId);
        } catch {
          // Ignore teardown races.
        }
      }
      await SherpaOnnx.unloadVad(instanceId);
    },
  };
  return engine;
}
